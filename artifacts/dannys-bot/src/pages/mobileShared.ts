/**
 * mobileShared.ts — shared types and constants used by both MobilePage.tsx
 * and TrustScoreDetailPage.tsx.  Extracted to a standalone module so neither
 * page has to import the other, preventing the Rollup TDZ crash in the
 * Electron production bundle ("Cannot access 'le' before initialization").
 */

import type { ImageFilterSettings } from "@/components/tools/ImageSettingsDialog";

/**
 * Read one local wallpaper through the native Electron picker when available,
 * or the browser file picker in Replit preview. The result is normalized to a
 * modest JPEG data URL before it is persisted in slot-customizations, keeping
 * localStorage from filling up with full-resolution camera images.
 */
export async function pickLocalWallpaper(): Promise<string | null> {
  let sourceDataUrl: string | null = null;
  const electronApi = (window as any).electronAPI;

  if (electronApi?.openWallpaperFileDialog) {
    const result = await electronApi.openWallpaperFileDialog().catch(() => null);
    if (!result || result.canceled || !result.dataUrl) return null;
    sourceDataUrl = result.dataUrl;
  } else {
    sourceDataUrl = await new Promise<string | null>((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.oncancel = () => resolve(null);
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      };
      input.click();
    });
  }

  if (!sourceDataUrl) return null;
  return normalizeWallpaperDataUrl(sourceDataUrl);
}

async function normalizeWallpaperDataUrl(sourceDataUrl: string): Promise<string> {
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = reject;
      element.src = sourceDataUrl;
    });
    const maxDimension = 1600;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return sourceDataUrl;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    // Keep unusual but valid browser-supported image formats usable even when
    // the canvas decoder cannot process them.
    return sourceDataUrl;
  }
}

// ─── UsbPhone ─────────────────────────────────────────────────────────────────

export interface UsbPhone {
  serial:          string;
  state:           "device" | "unauthorized" | "offline" | string;
  model?:          string;
  manufacturer?:   string;
  marketName?:     string;
  androidVersion?: string;
  product?:        string;
}

// ─── AutomationSettingsData ───────────────────────────────────────────────────

export interface AutomationSettingsData {
  enabled: boolean;
  cycleIntervalMin: number;
  cycleIntervalMax: number;
  feedEnabled: boolean;
  storiesEnabled: boolean;
  shuffleToolOrder: boolean;
  actionDelayMin: number;
  actionDelayMax: number;
  likePercentMin: number;
  likePercentMax: number;
  shareFeedPercentMin: number;
  shareFeedPercentMax: number;
  shareDmPercentMin: number;
  shareDmPercentMax: number;
  savePercentMin: number;
  savePercentMax: number;
  expandCaptionPercentMin: number;
  expandCaptionPercentMax: number;
  tapAudioPercentMin: number;
  tapAudioPercentMax: number;
  clickHashtagPercentMin: number;
  clickHashtagPercentMax: number;
  clickAuthorPercentMin: number;
  clickAuthorPercentMax: number;
  feedSuggestionsPercentMin: number;
  feedSuggestionsPercentMax: number;
  feedScrollMin: number;
  feedScrollMax: number;
  viewStoriesSlidesMin: number;
  viewStoriesSlidesMax: number;
  viewStoriesSlideWatchPctMin: number;
  viewStoriesSlideWatchPctMax: number;
  viewStoriesLikePercentMin: number;
  viewStoriesLikePercentMax: number;
  viewStoriesShareDmPercentMin: number;
  viewStoriesShareDmPercentMax: number;
  viewStoriesCommentPercentMin: number;
  viewStoriesCommentPercentMax: number;
  viewStoriesClickAuthorPercentMin: number;
  viewStoriesClickAuthorPercentMax: number;
  viewExploreEnabled: boolean;
  viewExploreActivatePctMin: number;
  viewExploreActivatePctMax: number;
  viewExploreScrollMin: number;
  viewExploreScrollMax: number;
  viewExploreActionDelayMin: number;
  viewExploreActionDelayMax: number;
  viewExploreClickPostPctMin: number;
  viewExploreClickPostPctMax: number;
  viewExploreLikePercentMin: number;
  viewExploreLikePercentMax: number;
  viewExploreShareFeedPercentMin: number;
  viewExploreShareFeedPercentMax: number;
  viewExploreShareDmPercentMin: number;
  viewExploreShareDmPercentMax: number;
  viewExploreSavePercentMin: number;
  viewExploreSavePercentMax: number;
  viewExploreClickAuthorPercentMin: number;
  viewExploreClickAuthorPercentMax: number;
  viewReelsEnabled: boolean;
  viewReelsScrollMin: number;
  viewReelsScrollMax: number;
  viewReelsLikePercentMin: number;
  viewReelsLikePercentMax: number;
  viewReelsShareFeedPercentMin: number;
  viewReelsShareFeedPercentMax: number;
  viewReelsShareDmPercentMin: number;
  viewReelsShareDmPercentMax: number;
  viewReelsSavePercentMin: number;
  viewReelsSavePercentMax: number;
  viewReelsClickAuthorPercentMin: number;
  viewReelsClickAuthorPercentMax: number;
  viewReelsActivatePctMin: number;
  viewReelsActivatePctMax: number;
  viewReelsWatchPctMin: number;
  viewReelsWatchPctMax: number;
  checkDmEnabled: boolean;
  checkDmActivatePctMin: number; checkDmActivatePctMax: number;
  checkDmScrollMin: number; checkDmScrollMax: number;
  checkDmClickPctMin: number; checkDmClickPctMax: number;
  followEnabled: boolean;
  followUsersMin: number;
  followUsersMax: number;
  followSpreadFollows: boolean;
  followSources: { type: string; value: string }[];
  injectBrowsingEnabled: boolean;
  injectBrowsingActivatePctMin: number; injectBrowsingActivatePctMax: number;
  injectBrowsingBeforeFollowPctMin: number; injectBrowsingBeforeFollowPctMax: number;
  injectBrowsingFeedMin: number; injectBrowsingFeedMax: number;
  injectBrowsingClickPostPctMin: number; injectBrowsingClickPostPctMax: number;
  injectBrowsingLikePctMin: number; injectBrowsingLikePctMax: number;
  injectBrowsingShareFeedPctMin: number; injectBrowsingShareFeedPctMax: number;
  injectBrowsingShareDmPctMin: number; injectBrowsingShareDmPctMax: number;
  injectBrowsingSavePostPctMin: number; injectBrowsingSavePostPctMax: number;
  injectBrowsingAbandonFollowPctMin: number; injectBrowsingAbandonFollowPctMax: number;
  injectBrowsingTapHighlightsPctMin: number; injectBrowsingTapHighlightsPctMax: number;
  followFiltersEnabled: boolean;
  followFilterPrivateUsers: boolean;
  followFilterEnglishSpeaking: boolean;
  followFilterMinFollowers50: boolean;
  followFilterVerifiedUsers: boolean;
  followFilterMaxFollowers25k: boolean;
  randomJitterEnabled: boolean;
  checkNotificationsPctMin: number; checkNotificationsPctMax: number;
  checkNotificationsScrollsMin: number; checkNotificationsScrollsMax: number;
  checkNotificationsClickPctMin: number; checkNotificationsClickPctMax: number;
  visitProfilePctMin: number; visitProfilePctMax: number;
  visitSavedPctMin: number; visitSavedPctMax: number;
  visitSettingsPctMin: number; visitSettingsPctMax: number;
  appSwitchPctMin: number; appSwitchPctMax: number;
  feedActivatePctMin: number; feedActivatePctMax: number;
  viewStoriesActivatePctMin: number; viewStoriesActivatePctMax: number;
  followActivatePctMin: number; followActivatePctMax: number;
  randomJitterActivatePctMin: number; randomJitterActivatePctMax: number;
  makePostEnabled: boolean;
  makePostActivatePctMin: number; makePostActivatePctMax: number;
  makePostPerSessionMin: number; makePostPerSessionMax: number;
  makePostAlterationEnabled: boolean;
  makePostAlterationLevel: "small" | "medium" | "high";
  makePostImageSettingsEnabled: boolean;
  makePostDisableWhenExhausted: boolean;
  /** Kept for runtime/backward compatibility with older saved settings. */
  makePostLocalFolderEnabled: boolean;
  makePostLocalFolderPath: string;
  makePostLocalFolderNoRepeat: boolean;
  makePostLocalFolderRandom: boolean;
  makePostLocalFolderDeleteAfterUpload: boolean;
  updateProfilePicActivatePctMin: number; updateProfilePicActivatePctMax: number;
  updateProfilePicFolderPath: string;
  updateProfilePicDisableAfterUsed: boolean;
  updateBioActivatePctMin: number; updateBioActivatePctMax: number;
  updateBioText: string;
  updateBioDisableAfterUsed: boolean;
  makePostUseChatGpt: boolean;
  makePostFixAiSlop: boolean;
  makePostMakeUnique: boolean;
  makePostPostToProfilePctMin: number; makePostPostToProfilePctMax: number;
  makePostPostToStoryPctMin: number; makePostPostToStoryPctMax: number;
  makePostCaptionText: string;
  makePostImageSettings: ImageFilterSettings;
  postStoryEnabled: boolean;
  postStoryActivatePctMin: number; postStoryActivatePctMax: number;
  postStoryLocalFolderPath: string;
  postStoryLocalFolderNoRepeat: boolean;
  postStoryLocalFolderRandom: boolean;
  postStoryAlterationEnabled: boolean;
  postStoryAlterationLevel: "small" | "medium" | "high";
  postStoryImageSettingsEnabled: boolean;
  postStoryImageSettings: ImageFilterSettings;
  postStoryFixAiSlop: boolean;
  postStoryMakeUnique: boolean;
  postStoryAddLink: boolean;
  postStoryLinkUrl: string;
  dismissDirection: "auto" | "left" | "up";
  /** Slot metadata returned by the effective-settings endpoint. */
  trustScoreId?: string | null;
  trustScoreConfigured?: boolean;
  trustScoreControlledFields?: string[];
  /** Tool switches intentionally disabled for this slot while inherited. */
  trustScoreDisabledTools?: string[];
  trustScoreToolOverrides?: Record<string, boolean>;
}

// ─── AUTOMATION_DEFAULTS ──────────────────────────────────────────────────────

export const AUTOMATION_DEFAULTS: AutomationSettingsData = {
  enabled: false, cycleIntervalMin: 20, cycleIntervalMax: 30,
  feedEnabled: true, storiesEnabled: true, shuffleToolOrder: false,
  actionDelayMin: 5, actionDelayMax: 10,
  likePercentMin: 3, likePercentMax: 5,
  shareFeedPercentMin: 0, shareFeedPercentMax: 0,
  shareDmPercentMin: 0, shareDmPercentMax: 0,
  savePercentMin: 0, savePercentMax: 0,
  expandCaptionPercentMin: 0, expandCaptionPercentMax: 0,
  tapAudioPercentMin: 0, tapAudioPercentMax: 0,
  clickHashtagPercentMin: 0, clickHashtagPercentMax: 0,
  clickAuthorPercentMin: 0, clickAuthorPercentMax: 0,
  feedSuggestionsPercentMin: 0, feedSuggestionsPercentMax: 0,
  feedScrollMin: 5, feedScrollMax: 10,
  viewStoriesSlidesMin: 0, viewStoriesSlidesMax: 0,
  viewStoriesSlideWatchPctMin: 50, viewStoriesSlideWatchPctMax: 90,
  viewStoriesLikePercentMin: 0, viewStoriesLikePercentMax: 0,
  viewStoriesShareDmPercentMin: 0, viewStoriesShareDmPercentMax: 0,
  viewStoriesCommentPercentMin: 0, viewStoriesCommentPercentMax: 0,
  viewStoriesClickAuthorPercentMin: 0, viewStoriesClickAuthorPercentMax: 0,
  viewExploreEnabled: false,
  viewExploreActivatePctMin: 100, viewExploreActivatePctMax: 100,
  viewExploreScrollMin: 0, viewExploreScrollMax: 0,
  viewExploreActionDelayMin: 3, viewExploreActionDelayMax: 6,
  viewExploreClickPostPctMin: 0, viewExploreClickPostPctMax: 0,
  viewExploreLikePercentMin: 0, viewExploreLikePercentMax: 0,
  viewExploreShareFeedPercentMin: 0, viewExploreShareFeedPercentMax: 0,
  viewExploreShareDmPercentMin: 0, viewExploreShareDmPercentMax: 0,
  viewExploreSavePercentMin: 0, viewExploreSavePercentMax: 0,
  viewExploreClickAuthorPercentMin: 0, viewExploreClickAuthorPercentMax: 0,
  viewReelsEnabled: false,
  viewReelsScrollMin: 0, viewReelsScrollMax: 0,
  viewReelsLikePercentMin: 0, viewReelsLikePercentMax: 0,
  viewReelsShareFeedPercentMin: 0, viewReelsShareFeedPercentMax: 0,
  viewReelsShareDmPercentMin: 0, viewReelsShareDmPercentMax: 0,
  viewReelsSavePercentMin: 0, viewReelsSavePercentMax: 0,
  viewReelsClickAuthorPercentMin: 0, viewReelsClickAuthorPercentMax: 0,
  viewReelsActivatePctMin: 100, viewReelsActivatePctMax: 100,
  viewReelsWatchPctMin: 30, viewReelsWatchPctMax: 70,
  checkDmEnabled: false,
  checkDmActivatePctMin: 100, checkDmActivatePctMax: 100,
  checkDmScrollMin: 1, checkDmScrollMax: 3,
  checkDmClickPctMin: 0, checkDmClickPctMax: 0,
  followEnabled: false,
  followUsersMin: 1, followUsersMax: 3,
  followSpreadFollows: false,
  followSources: [],
  injectBrowsingEnabled: false,
  injectBrowsingActivatePctMin: 0, injectBrowsingActivatePctMax: 0,
  injectBrowsingBeforeFollowPctMin: 0, injectBrowsingBeforeFollowPctMax: 0,
  injectBrowsingFeedMin: 3, injectBrowsingFeedMax: 6,
  injectBrowsingClickPostPctMin: 0, injectBrowsingClickPostPctMax: 0,
  injectBrowsingLikePctMin: 0, injectBrowsingLikePctMax: 0,
  injectBrowsingShareFeedPctMin: 0, injectBrowsingShareFeedPctMax: 0,
  injectBrowsingShareDmPctMin: 0, injectBrowsingShareDmPctMax: 0,
  injectBrowsingSavePostPctMin: 0, injectBrowsingSavePostPctMax: 0,
  injectBrowsingAbandonFollowPctMin: 0, injectBrowsingAbandonFollowPctMax: 0,
  injectBrowsingTapHighlightsPctMin: 0, injectBrowsingTapHighlightsPctMax: 0,
  followFiltersEnabled: false,
  followFilterPrivateUsers: false,
  followFilterEnglishSpeaking: false,
  followFilterMinFollowers50: false,
  followFilterVerifiedUsers: false,
  followFilterMaxFollowers25k: false,
  randomJitterEnabled: false,
  checkNotificationsPctMin: 0, checkNotificationsPctMax: 0,
  checkNotificationsScrollsMin: 2, checkNotificationsScrollsMax: 5,
  checkNotificationsClickPctMin: 0, checkNotificationsClickPctMax: 0,
  visitProfilePctMin: 0, visitProfilePctMax: 0,
  visitSavedPctMin: 0, visitSavedPctMax: 0,
  visitSettingsPctMin: 0, visitSettingsPctMax: 0,
  appSwitchPctMin: 0, appSwitchPctMax: 0,
  feedActivatePctMin: 100, feedActivatePctMax: 100,
  viewStoriesActivatePctMin: 100, viewStoriesActivatePctMax: 100,
  followActivatePctMin: 100, followActivatePctMax: 100,
  randomJitterActivatePctMin: 100, randomJitterActivatePctMax: 100,
  makePostEnabled: false,
  makePostActivatePctMin: 100, makePostActivatePctMax: 100,
  makePostPerSessionMin: 1, makePostPerSessionMax: 1,
  makePostAlterationEnabled: true,
  makePostAlterationLevel: "small",
  makePostImageSettingsEnabled: true,
  makePostDisableWhenExhausted: true,
  makePostLocalFolderEnabled: true,
  makePostLocalFolderPath: "",
  makePostLocalFolderNoRepeat: false,
  makePostLocalFolderRandom: false,
  makePostLocalFolderDeleteAfterUpload: false,
  updateProfilePicActivatePctMin: 0, updateProfilePicActivatePctMax: 0,
  updateProfilePicFolderPath: "",
  updateProfilePicDisableAfterUsed: false,
  updateBioActivatePctMin: 0, updateBioActivatePctMax: 0,
  updateBioText: "",
  updateBioDisableAfterUsed: false,
  makePostUseChatGpt: false,
  makePostFixAiSlop: false,
  makePostMakeUnique: false,
  makePostPostToProfilePctMin: 100, makePostPostToProfilePctMax: 100,
  makePostPostToStoryPctMin: 0, makePostPostToStoryPctMax: 0,
  makePostCaptionText: "",
  makePostImageSettings: {
    contrast:  { enabled: true, min: 5,   max: 250 },
    brightness:{ enabled: true, min: 5,   max: 250 },
    noise:     { enabled: true, min: 5,   max: 15  },
    sharpen:   { enabled: true, min: 1.0, max: 2.0 },
    pixelate:  { enabled: true, min: 0.9, max: 2.1 },
  },
  postStoryEnabled: false,
  postStoryActivatePctMin: 100, postStoryActivatePctMax: 100,
  postStoryLocalFolderPath: "",
  postStoryLocalFolderNoRepeat: false,
  postStoryLocalFolderRandom: false,
  postStoryAlterationEnabled: true,
  postStoryAlterationLevel: "small",
  postStoryImageSettingsEnabled: true,
  postStoryImageSettings: {
    contrast: { enabled: true, min: 5, max: 250 },
    brightness: { enabled: true, min: 5, max: 250 },
    noise: { enabled: true, min: 5, max: 15 },
    sharpen: { enabled: true, min: 1.0, max: 2.0 },
    pixelate: { enabled: true, min: 0.9, max: 2.1 },
  },
  postStoryFixAiSlop: false,
  postStoryMakeUnique: false,
  postStoryAddLink: false,
  postStoryLinkUrl: "",
  dismissDirection: "auto",
};

// ─── Copy-settings types & constants ─────────────────────────────────────────

export type CopySubSetting = { key: string; label: string; fields: string[] };
export type CopySection    = { key: string; label: string; sub: CopySubSetting[] };

/** Values owned by a physical slot rather than a TrustScore template. */
export const TRUST_SCORE_SLOT_OWNED_FIELDS = new Set([
  "enabled",
  "trustScoreId",
  "trustScoreConfigured",
  "trustScoreControlledFields",
  "trustScoreDisabledTools",
  "trustScoreToolOverrides",
  "followSources",
  "injectBrowsingEnabled",
  "followFiltersEnabled",
  "followFilterPrivateUsers",
  "followFilterEnglishSpeaking",
  "followFilterMinFollowers50",
  "followFilterVerifiedUsers",
  "followFilterMaxFollowers25k",
  "updateProfilePicFolderPath",
  "updateBioText",
  "makePostLocalFolderEnabled",
  "makePostLocalFolderPath",
  "postStoryAddLink",
  "postStoryLinkUrl",
]);

/** Fields that stay restricted in Settings → TrustScores. Inject Browsing
 * and Follow Filters are intentionally omitted because their controls must
 * remain editable in the TrustScore editor. */
export const TRUST_SCORE_TEMPLATE_LOCKED_FIELDS = new Set(
  [...TRUST_SCORE_SLOT_OWNED_FIELDS].filter(field => ![
    "injectBrowsingEnabled",
    "followFiltersEnabled",
    "followFilterPrivateUsers",
    "followFilterEnglishSpeaking",
    "followFilterMinFollowers50",
    "followFilterVerifiedUsers",
    "followFilterMaxFollowers25k",
  ].includes(field)),
);

/** Account-specific values that may be copied between Human Session Tool slots. */
export const COPYABLE_ACCOUNT_SPECIFIC_FIELDS = new Set([
  "followSources",
  "updateProfilePicFolderPath",
  "updateBioText",
  "makePostLocalFolderPath",
  "postStoryLinkUrl",
]);

export const COPY_SECTIONS: CopySection[] = [
  { key: 'runInterval',   label: 'Human Session Tool', sub: [
    { key: 'masterEnabled',      label: 'Enabled',                       fields: ['enabled'] },
    { key: 'cycleInterval',     label: 'Run every X - Y minutes',      fields: ['cycleIntervalMin','cycleIntervalMax'] },
    { key: 'shuffleToolOrder',  label: 'Shuffle tool order',           fields: ['shuffleToolOrder'] },
  ]},
  { key: 'feed',          label: 'View Feed', sub: [
    { key: 'feedEnabled',       label: 'Enabled',                       fields: ['feedEnabled'] },
    { key: 'feedActivatePct',   label: 'Activate Percentage',           fields: ['feedActivatePctMin','feedActivatePctMax'] },
    { key: 'feedScroll',        label: 'Scroll amount',                 fields: ['feedScrollMin','feedScrollMax'] },
    { key: 'actionDelay',       label: 'Delay between actions (s)',     fields: ['actionDelayMin','actionDelayMax'] },
    { key: 'feedLike',          label: 'Like %',                        fields: ['likePercentMin','likePercentMax'] },
    { key: 'feedShareFeed',     label: 'Share to Feed %',               fields: ['shareFeedPercentMin','shareFeedPercentMax'] },
    { key: 'feedShareDm',       label: 'Share via DM %',                fields: ['shareDmPercentMin','shareDmPercentMax'] },
    { key: 'feedSavePct',       label: 'Save %',                        fields: ['savePercentMin','savePercentMax'] },
    { key: 'feedExpandCaption', label: 'Expand Caption %',              fields: ['expandCaptionPercentMin','expandCaptionPercentMax'] },
    { key: 'feedTapAudio',      label: 'Tap Audio %',                   fields: ['tapAudioPercentMin','tapAudioPercentMax'] },
    { key: 'feedClickHashtag',  label: 'Click Hashtag %',               fields: ['clickHashtagPercentMin','clickHashtagPercentMax'] },
    { key: 'feedClickAuthor',   label: 'Click Author %',                fields: ['clickAuthorPercentMin','clickAuthorPercentMax'] },
    { key: 'feedSuggestions',   label: 'Suggestions %',                 fields: ['feedSuggestionsPercentMin','feedSuggestionsPercentMax'] },
  ]},
  { key: 'stories',       label: 'View Stories', sub: [
    { key: 'storiesEnabled',    label: 'Enabled',                       fields: ['storiesEnabled'] },
    { key: 'storiesActivate',   label: 'Activate Percentage',           fields: ['viewStoriesActivatePctMin','viewStoriesActivatePctMax'] },
    { key: 'storiesSlides',     label: 'Stories to watch',              fields: ['viewStoriesSlidesMin','viewStoriesSlidesMax'] },
    { key: 'storiesWatchPct',   label: '% to watch',                    fields: ['viewStoriesSlideWatchPctMin','viewStoriesSlideWatchPctMax'] },
    { key: 'storiesLike',       label: 'Like %',                        fields: ['viewStoriesLikePercentMin','viewStoriesLikePercentMax'] },
    { key: 'storiesShareDm',    label: 'Share DM %',                    fields: ['viewStoriesShareDmPercentMin','viewStoriesShareDmPercentMax'] },
    { key: 'storiesComment',    label: 'Comment %',                     fields: ['viewStoriesCommentPercentMin','viewStoriesCommentPercentMax'] },
    { key: 'storiesClickAuthor', label: 'Click Author %',               fields: ['viewStoriesClickAuthorPercentMin','viewStoriesClickAuthorPercentMax'] },
  ]},
  { key: 'explore',       label: 'View Explore Page', sub: [
    { key: 'exploreEnabled',    label: 'Enabled',                       fields: ['viewExploreEnabled'] },
    { key: 'exploreActivate',   label: 'Activate Percentage',           fields: ['viewExploreActivatePctMin','viewExploreActivatePctMax'] },
    { key: 'exploreScroll',     label: 'Scroll amount',                 fields: ['viewExploreScrollMin','viewExploreScrollMax'] },
    { key: 'exploreDelay',      label: 'Delay between actions (s)',     fields: ['viewExploreActionDelayMin','viewExploreActionDelayMax'] },
    { key: 'exploreClickPost',  label: 'Click posts %',                 fields: ['viewExploreClickPostPctMin','viewExploreClickPostPctMax'] },
    { key: 'exploreLike',       label: 'Like %',                        fields: ['viewExploreLikePercentMin','viewExploreLikePercentMax'] },
    { key: 'exploreShareFeed',  label: 'Share to Feed %',               fields: ['viewExploreShareFeedPercentMin','viewExploreShareFeedPercentMax'] },
    { key: 'exploreShareDm',    label: 'Share via DM %',                fields: ['viewExploreShareDmPercentMin','viewExploreShareDmPercentMax'] },
    { key: 'exploreSave',       label: 'Save %',                        fields: ['viewExploreSavePercentMin','viewExploreSavePercentMax'] },
    { key: 'exploreClickAuthor', label: 'Click Author %',               fields: ['viewExploreClickAuthorPercentMin','viewExploreClickAuthorPercentMax'] },
  ]},
  { key: 'reels',         label: 'View Reels', sub: [
    { key: 'reelsEnabled',      label: 'Enabled',                       fields: ['viewReelsEnabled'] },
    { key: 'reelsActivate',     label: 'Activate Percentage',           fields: ['viewReelsActivatePctMin','viewReelsActivatePctMax'] },
    { key: 'reelsScroll',       label: 'Scroll amount',                 fields: ['viewReelsScrollMin','viewReelsScrollMax'] },
    { key: 'reelsWatchPct',     label: 'Watch %',                       fields: ['viewReelsWatchPctMin','viewReelsWatchPctMax'] },
    { key: 'reelsLike',         label: 'Like %',                        fields: ['viewReelsLikePercentMin','viewReelsLikePercentMax'] },
    { key: 'reelsShareFeed',    label: 'Share to Feed %',               fields: ['viewReelsShareFeedPercentMin','viewReelsShareFeedPercentMax'] },
    { key: 'reelsSave',         label: 'Save %',                        fields: ['viewReelsSavePercentMin','viewReelsSavePercentMax'] },
    { key: 'reelsShareDm',      label: 'Share via DM %',                fields: ['viewReelsShareDmPercentMin','viewReelsShareDmPercentMax'] },
    { key: 'reelsClickAuthor',  label: 'Click Author %',                fields: ['viewReelsClickAuthorPercentMin','viewReelsClickAuthorPercentMax'] },
  ]},
  { key: 'checkDm',       label: 'Direct Messaging', sub: [
    { key: 'checkDmEnabled',    label: 'Enabled',                       fields: ['checkDmEnabled'] },
    { key: 'checkDmActivate',   label: 'Activate Percentage',           fields: ['checkDmActivatePctMin','checkDmActivatePctMax'] },
    { key: 'checkDmScroll',     label: 'Scroll amount',                 fields: ['checkDmScrollMin','checkDmScrollMax'] },
    { key: 'checkDmClickPct',   label: 'Click Thread %',                fields: ['checkDmClickPctMin','checkDmClickPctMax'] },
  ]},
  { key: 'follow',        label: 'Follow Users', sub: [
    { key: 'followEnabled',     label: 'Enabled',                       fields: ['followEnabled'] },
    { key: 'followActivate',    label: 'Activate Percentage',           fields: ['followActivatePctMin','followActivatePctMax'] },
    { key: 'followCount',       label: 'Follow count per session',      fields: ['followUsersMin','followUsersMax'] },
    { key: 'followSpread',      label: 'Spread Follows',                fields: ['followSpreadFollows'] },
    { key: 'followSources',     label: 'Follow sources list',           fields: ['followSources'] },
    { key: 'injectAbandon',     label: 'Abandon Follow %',              fields: ['injectBrowsingAbandonFollowPctMin','injectBrowsingAbandonFollowPctMax'] },
  ]},
  { key: 'followFilters', label: 'Follow Filters', sub: [
    { key: 'filtersEnabled',    label: 'Master toggle',                 fields: ['followFiltersEnabled'] },
    { key: 'filterPrivate',     label: 'Skip Private users',            fields: ['followFilterPrivateUsers'] },
    { key: 'filterEnglish',     label: 'English Speaking only',         fields: ['followFilterEnglishSpeaking'] },
    { key: 'filterMin50',       label: '50+ Followers min',             fields: ['followFilterMinFollowers50'] },
    { key: 'filterVerified',    label: 'Skip Verified users',           fields: ['followFilterVerifiedUsers'] },
    { key: 'filterMax25k',      label: 'Skip 25K+ Followers',           fields: ['followFilterMaxFollowers25k'] },
  ]},
  { key: 'injectBrowsing',label: 'Inject Browsing', sub: [
    { key: 'injectEnabled',     label: 'Enabled',                       fields: ['injectBrowsingEnabled'] },
    { key: 'injectActivate',    label: 'Activate Percentage',           fields: ['injectBrowsingActivatePctMin','injectBrowsingActivatePctMax'] },
    { key: 'injectBefore',      label: 'Before Follow %',               fields: ['injectBrowsingBeforeFollowPctMin','injectBrowsingBeforeFollowPctMax'] },
    { key: 'injectFeedCount',   label: 'Feed posts to view',            fields: ['injectBrowsingFeedMin','injectBrowsingFeedMax'] },
    { key: 'injectClickPost',   label: 'Click post %',                  fields: ['injectBrowsingClickPostPctMin','injectBrowsingClickPostPctMax'] },
    { key: 'injectLike',        label: 'Like %',                        fields: ['injectBrowsingLikePctMin','injectBrowsingLikePctMax'] },
    { key: 'injectShareFeed',   label: 'Share to Feed %',               fields: ['injectBrowsingShareFeedPctMin','injectBrowsingShareFeedPctMax'] },
    { key: 'injectShareDm',     label: 'Share DM %',                    fields: ['injectBrowsingShareDmPctMin','injectBrowsingShareDmPctMax'] },
    { key: 'injectSavePost',    label: 'Save Post %',                   fields: ['injectBrowsingSavePostPctMin','injectBrowsingSavePostPctMax'] },
    { key: 'injectAbandon',     label: 'Abandon Follow %',              fields: ['injectBrowsingAbandonFollowPctMin','injectBrowsingAbandonFollowPctMax'] },
    { key: 'injectTapHL',       label: 'Tap Highlights %',              fields: ['injectBrowsingTapHighlightsPctMin','injectBrowsingTapHighlightsPctMax'] },
  ]},
  { key: 'randomJitter',  label: 'Random Actions', sub: [
    { key: 'jitterEnabled',     label: 'Enabled',                       fields: ['randomJitterEnabled'] },
    { key: 'jitterActivate',    label: 'Activate Percentage',           fields: ['randomJitterActivatePctMin','randomJitterActivatePctMax'] },
    { key: 'jitterNotifPct',    label: 'Check Notifications %',         fields: ['checkNotificationsPctMin','checkNotificationsPctMax'] },
    { key: 'jitterNotifScroll', label: 'Notification scrolls',          fields: ['checkNotificationsScrollsMin','checkNotificationsScrollsMax'] },
    { key: 'jitterNotifClick',  label: 'Notification click %',          fields: ['checkNotificationsClickPctMin','checkNotificationsClickPctMax'] },
    { key: 'jitterVisitPct',    label: 'Visit Profile %',               fields: ['visitProfilePctMin','visitProfilePctMax'] },
    { key: 'jitterVisitSaved',     label: 'Visit Saved %',              fields: ['visitSavedPctMin','visitSavedPctMax'] },
    { key: 'jitterVisitSettings',  label: 'Visit Random Settings %',   fields: ['visitSettingsPctMin','visitSettingsPctMax'] },
    { key: 'jitterAppSwitch',      label: 'App Switch %',              fields: ['appSwitchPctMin','appSwitchPctMax'] },
    { key: 'jitterUpdateProfilePic', label: 'Update Profile Picture',  fields: ['updateProfilePicActivatePctMin','updateProfilePicActivatePctMax','updateProfilePicDisableAfterUsed'] },
    { key: 'jitterUpdateProfilePicFolder', label: 'Profile-picture directory', fields: ['updateProfilePicFolderPath'] },
    { key: 'jitterUpdateBio',        label: 'Update Bio',              fields: ['updateBioActivatePctMin','updateBioActivatePctMax','updateBioDisableAfterUsed'] },
    { key: 'jitterUpdateBioSpin',    label: 'Update Bio spin text',     fields: ['updateBioText'] },
  ]},
  { key: 'makePost',      label: 'Make a Post', sub: [
    { key: 'postEnabled',       label: 'Enabled',                       fields: ['makePostEnabled'] },
    { key: 'postActivate',      label: 'Activate Percentage',           fields: ['makePostActivatePctMin','makePostActivatePctMax'] },
    { key: 'postPerSession',    label: 'Posts per session',             fields: ['makePostPerSessionMin','makePostPerSessionMax'] },
    { key: 'postAlteration',    label: 'Image Alteration',              fields: ['makePostAlterationEnabled','makePostAlterationLevel'] },
    { key: 'postImgSettings',   label: 'Image Settings',                fields: ['makePostImageSettingsEnabled','makePostImageSettings'] },
    { key: 'postLocalFolder',   label: 'My Computer directory',          fields: ['makePostLocalFolderPath'] },
    { key: 'postLocalOpts',     label: 'My Computer options',            fields: ['makePostLocalFolderNoRepeat','makePostLocalFolderRandom'] },
    { key: 'postDisableAt',     label: 'Disable when no more posts are found', fields: ['makePostDisableWhenExhausted'] },
    { key: 'postChatGptCaption',label: 'ChatGPT / caption settings',    fields: ['makePostUseChatGpt','makePostCaptionText'] },
    { key: 'postFixAiSlop',      label: 'Fix AI Slop',                   fields: ['makePostFixAiSlop'] },
    { key: 'postMakeUnique',     label: 'Make it unique',                fields: ['makePostMakeUnique'] },
  ]},
  { key: 'postStory',      label: 'Post a Story', sub: [
    { key: 'storyPostEnabled',   label: 'Enabled',             fields: ['postStoryEnabled'] },
    { key: 'storyPostActivate',  label: 'Activate Percentage', fields: ['postStoryActivatePctMin','postStoryActivatePctMax'] },
    { key: 'storyPostOptions',   label: 'Directory options',   fields: ['postStoryLocalFolderNoRepeat','postStoryLocalFolderRandom'] },
    { key: 'storyPostAddLink',   label: 'Add Link',             fields: ['postStoryAddLink'] },
    { key: 'storyPostLinkUrl',   label: 'Link URL',             fields: ['postStoryLinkUrl'] },
    { key: 'storyPostAlteration', label: 'Image Alteration',    fields: ['postStoryAlterationEnabled','postStoryAlterationLevel'] },
    { key: 'storyPostImageSettings', label: 'Image Settings',   fields: ['postStoryImageSettingsEnabled','postStoryImageSettings'] },
    { key: 'storyPostFixAiSlop', label: 'Fix AI Slop',           fields: ['postStoryFixAiSlop'] },
    { key: 'storyPostUnique',    label: 'Make it unique',      fields: ['postStoryMakeUnique'] },
  ]},
];
