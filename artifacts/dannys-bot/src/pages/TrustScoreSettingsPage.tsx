import { useState, useCallback } from "react";
import { useRoute, useLocation } from "wouter";
import { Switch } from "@/components/ui/switch";
import { getTrustLevels, type TrustLevelEntry } from "@/components/TrustScoreBadge";
import { ImageSettingsDialog, type ImageFilterSettings } from "@/components/tools/ImageSettingsDialog";
import {
  ArrowLeft, ChevronDown, ChevronUp,
  Rss, BookOpen, Compass, Film,
  Users, Bell, ImagePlus,
} from "lucide-react";

// ── Storage ───────────────────────────────────────────────────────────────────
// Each trust score ID gets its own localStorage entry, keyed with the mobile
// engine schema version. Old "ts_hs_settings_v1_*" entries (browser engine)
// are deliberately not migrated — those fields are gone.

const LS_KEY = (id: string) => `ts_mobile_hs_v1_${id}`;

// Default image filter settings — mirrors AUTOMATION_DEFAULTS.makePostImageSettings
const DEFAULT_IMAGE_SETTINGS: ImageFilterSettings = {
  contrast:   { enabled: true, min: 5,   max: 250 },
  brightness: { enabled: true, min: 5,   max: 250 },
  noise:      { enabled: true, min: 5,   max: 15  },
  sharpen:    { enabled: true, min: 1.0, max: 2.0 },
  pixelate:   { enabled: true, min: 0.9, max: 2.1 },
};

// All fields mirror AutomationSettingsData in MobilePage.tsx, minus the
// slot-specific fields: enabled, followSources, dismissDirection.
const DEFAULTS = {
  // Cycle timing
  cycleIntervalMin: 20, cycleIntervalMax: 30,
  shuffleToolOrder: false,

  // View Feed
  feedEnabled: true,
  feedActivatePctMin: 100, feedActivatePctMax: 100,
  actionDelayMin: 5, actionDelayMax: 10,
  feedScrollMin: 5, feedScrollMax: 10,
  likePercentMin: 3, likePercentMax: 5,
  shareFeedPercentMin: 0, shareFeedPercentMax: 0,
  shareDmPercentMin: 0, shareDmPercentMax: 0,
  savePercentMin: 0, savePercentMax: 0,

  // View Stories from Feed
  storiesEnabled: true,
  viewStoriesActivatePctMin: 100, viewStoriesActivatePctMax: 100,
  viewStoriesSlidesMin: 0, viewStoriesSlidesMax: 0,
  viewStoriesSlideWatchPctMin: 50, viewStoriesSlideWatchPctMax: 90,
  viewStoriesLikePercentMin: 0, viewStoriesLikePercentMax: 0,
  viewStoriesShareDmPercentMin: 0, viewStoriesShareDmPercentMax: 0,

  // View Explore Page
  viewExploreEnabled: false,
  viewExploreActivatePctMin: 100, viewExploreActivatePctMax: 100,
  viewExploreScrollMin: 0, viewExploreScrollMax: 0,
  viewExploreActionDelayMin: 3, viewExploreActionDelayMax: 6,
  viewExploreClickPostPctMin: 0, viewExploreClickPostPctMax: 0,
  viewExploreLikePercentMin: 0, viewExploreLikePercentMax: 0,
  viewExploreShareFeedPercentMin: 0, viewExploreShareFeedPercentMax: 0,
  viewExploreShareDmPercentMin: 0, viewExploreShareDmPercentMax: 0,
  viewExploreSavePercentMin: 0, viewExploreSavePercentMax: 0,

  // View Reels
  viewReelsEnabled: false,
  viewReelsActivatePctMin: 100, viewReelsActivatePctMax: 100,
  viewReelsScrollMin: 0, viewReelsScrollMax: 0,
  viewReelsWatchPctMin: 30, viewReelsWatchPctMax: 70,
  viewReelsLikePercentMin: 0, viewReelsLikePercentMax: 0,
  viewReelsShareFeedPercentMin: 0, viewReelsShareFeedPercentMax: 0,
  viewReelsShareDmPercentMin: 0, viewReelsShareDmPercentMax: 0,
  viewReelsSavePercentMin: 0, viewReelsSavePercentMax: 0,

  // Follow Users
  followEnabled: false,
  followActivatePctMin: 100, followActivatePctMax: 100,
  followUsersMin: 1, followUsersMax: 3,
  followSpreadFollows: false,

  // Inject Browsing (woven into Follow Users)
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

  // Follow Filters
  followFiltersEnabled: false,
  followFilterPrivateUsers: false,
  followFilterEnglishSpeaking: false,
  followFilterMinFollowers50: false,
  followFilterVerifiedUsers: false,
  followFilterMaxFollowers25k: false,

  // Random Jitter
  randomJitterEnabled: false,
  randomJitterActivatePctMin: 100, randomJitterActivatePctMax: 100,
  checkNotificationsPctMin: 0, checkNotificationsPctMax: 0,
  checkNotificationsScrollsMin: 2, checkNotificationsScrollsMax: 5,
  checkNotificationsClickPctMin: 0, checkNotificationsClickPctMax: 0,
  visitProfilePctMin: 0, visitProfilePctMax: 0,

  // Make a Post
  makePostEnabled: false,
  makePostActivatePctMin: 100, makePostActivatePctMax: 100,
  makePostPerSessionMin: 1, makePostPerSessionMax: 1,
  makePostSourceUsername: "",
  makePostDisableUsernameSource: false,
  makePostAlterationEnabled: true,
  makePostAlterationLevel: "small" as "small" | "medium" | "high",
  makePostImageSettingsEnabled: true,
  makePostUseHikerApi: false,
  makePostDisableAtPostCount: 0,
  makePostDisableWhenExhausted: true,
  makePostLocalFolderEnabled: false,
  makePostLocalFolderPath: "",
  makePostLocalFolderNoRepeat: false,
  makePostLocalFolderRandom: false,
  makePostLocalFolderDeleteAfterUpload: true,
  makePostUseChatGpt: false,
  makePostFixAiSlop: false,
  makePostMakeUnique: false,
  makePostCaptionText: "",
  makePostImageSettings: DEFAULT_IMAGE_SETTINGS as ImageFilterSettings,
};

type HsSettings = typeof DEFAULTS;
type Setter = <K extends keyof HsSettings>(key: K, value: HsSettings[K]) => void;

function loadSettings(id: string): HsSettings {
  try {
    const raw = localStorage.getItem(LS_KEY(id));
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULTS };
}

function saveSettings(id: string, s: HsSettings) {
  try { localStorage.setItem(LS_KEY(id), JSON.stringify(s)); } catch {}
}

// ── Primitive row components ──────────────────────────────────────────────────

function Row({ label, desc, right }: { label: string; desc?: string; right: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 border-b border-border/40 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        {desc && <div className="text-[11px] text-muted-foreground mt-0.5">{desc}</div>}
      </div>
      <div className="flex items-center gap-2 shrink-0">{right}</div>
    </div>
  );
}

function SRow({ label, desc, k, s, set }: { label: string; desc?: string; k: keyof HsSettings; s: HsSettings; set: Setter }) {
  return (
    <Row label={label} desc={desc} right={
      <Switch checked={!!s[k]} onCheckedChange={v => set(k, v as HsSettings[typeof k])} />
    } />
  );
}

function CRow({ label, desc, k, s, set }: { label: string; desc?: string; k: keyof HsSettings; s: HsSettings; set: Setter }) {
  return (
    <Row label={label} desc={desc} right={
      <input
        type="checkbox"
        checked={!!s[k]}
        onChange={e => set(k, e.target.checked as HsSettings[typeof k])}
        className="w-4 h-4 accent-primary cursor-pointer"
      />
    } />
  );
}

function RRow({ label, desc, minK, maxK, s, set, unit, max }: {
  label: string; desc?: string;
  minK: keyof HsSettings; maxK: keyof HsSettings;
  s: HsSettings; set: Setter; unit?: string; max?: number;
}) {
  return (
    <Row label={label} desc={desc} right={
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          value={s[minK] as number}
          min={0}
          max={max}
          onChange={e => set(minK, Math.max(0, max !== undefined ? Math.min(max, Number(e.target.value)) : Number(e.target.value)) as HsSettings[typeof minK])}
          className="w-16 h-7 rounded-md border border-border bg-background px-2 text-xs text-center outline-none focus:ring-1 focus:ring-primary"
        />
        <span className="text-xs text-muted-foreground">–</span>
        <input
          type="number"
          value={s[maxK] as number}
          min={0}
          max={max}
          onChange={e => set(maxK, Math.max(0, max !== undefined ? Math.min(max, Number(e.target.value)) : Number(e.target.value)) as HsSettings[typeof maxK])}
          className="w-16 h-7 rounded-md border border-border bg-background px-2 text-xs text-center outline-none focus:ring-1 focus:ring-primary"
        />
        {unit && <span className="text-[11px] text-muted-foreground w-6">{unit}</span>}
      </div>
    } />
  );
}

function NRow({ label, desc, k, s, set, unit, min: minVal }: {
  label: string; desc?: string; k: keyof HsSettings; s: HsSettings; set: Setter; unit?: string; min?: number;
}) {
  return (
    <Row label={label} desc={desc} right={
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          value={s[k] as number}
          min={minVal ?? 0}
          onChange={e => set(k, Math.max(minVal ?? 0, Number(e.target.value)) as HsSettings[typeof k])}
          className="w-20 h-7 rounded-md border border-border bg-background px-2 text-xs text-center outline-none focus:ring-1 focus:ring-primary"
        />
        {unit && <span className="text-[11px] text-muted-foreground">{unit}</span>}
      </div>
    } />
  );
}

function TRow({ label, desc, k, s, set, placeholder }: {
  label: string; desc?: string; k: keyof HsSettings; s: HsSettings; set: Setter; placeholder?: string;
}) {
  return (
    <Row label={label} desc={desc} right={
      <input
        type="text"
        value={s[k] as string}
        onChange={e => set(k, e.target.value as HsSettings[typeof k])}
        placeholder={placeholder}
        className="w-44 h-7 rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-primary"
      />
    } />
  );
}

// ── Collapsible section card ──────────────────────────────────────────────────

function Section({
  icon: Icon, title, open, onToggle, children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <button
        className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-accent/40 transition-colors"
        onClick={onToggle}
      >
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-semibold">{title}</span>
        </div>
        {open
          ? <ChevronUp className="w-4 h-4 text-muted-foreground" />
          : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>
      {open && <div className="px-4 pb-3">{children}</div>}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function TrustScoreSettingsPage() {
  const [, params] = useRoute<{ id: string }>("/trust-score-settings/:id");
  const [, setLocation] = useLocation();
  const id = params?.id ?? "";

  const level: TrustLevelEntry | undefined = getTrustLevels().find(l => l.id === id);
  const [s, setS] = useState<HsSettings>(() => loadSettings(id));
  const [imageSettingsOpen, setImageSettingsOpen] = useState(false);

  const [open, setOpen] = useState<Record<string, boolean>>({
    general: true,
    feed: true,
    stories: false,
    explore: false,
    reels: false,
    follow: false,
    injectBrowsing: false,
    followFilters: false,
    jitter: false,
    makePost: false,
  });
  const toggle = (key: string) => setOpen(prev => ({ ...prev, [key]: !prev[key] }));

  const set: Setter = useCallback(<K extends keyof HsSettings>(key: K, value: HsSettings[K]) => {
    setS(prev => {
      const next = { ...prev, [key]: value };
      saveSettings(id, next);
      return next;
    });
  }, [id]);

  if (!level) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
        <p className="text-sm">Trust score not found.</p>
        <button className="text-xs underline hover:text-foreground" onClick={() => setLocation("/settings")}>
          Back to Settings
        </button>
      </div>
    );
  }

  const BadgeIcon = level.icon;

  return (
    <div className="px-6 py-6 max-w-3xl mx-auto space-y-3">

      {/* Header */}
      <div className="flex items-center gap-3 mb-1">
        <button
          onClick={() => setLocation("/settings")}
          className="p-1.5 rounded-md hover:bg-accent transition-colors shrink-0"
          title="Back to Settings"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <span
          className="inline-flex items-center justify-center gap-1.5 rounded-full px-3.5 py-1.5 shrink-0"
          style={{ background: level.bg, border: `1px solid ${level.border}` }}
        >
          <span style={{ fontSize: 13, fontWeight: 700, color: level.text, letterSpacing: "0.05em", whiteSpace: "nowrap" }}>
            {level.label}
          </span>
          <BadgeIcon size={13} color={level.text} fill={level.text} strokeWidth={2} />
        </span>
        <div>
          <h1 className="text-base font-bold leading-tight">Mobile Human Session Settings</h1>
          <p className="text-xs text-muted-foreground">Applied to Phone Farm device slots assigned this trust score.</p>
        </div>
      </div>

      {/* General / Cycle timing */}
      <Section icon={Bell} title="General" open={open.general} onToggle={() => toggle("general")}>
        <RRow label="Run every (minutes)" desc="How often the automation cycle fires" minK="cycleIntervalMin" maxK="cycleIntervalMax" s={s} set={set} unit="min" />
        <CRow label="Shuffle tool order" desc="Randomise which tool runs first each cycle" k="shuffleToolOrder" s={s} set={set} />
      </Section>

      {/* View Feed */}
      <Section icon={Rss} title="View Feed" open={open.feed} onToggle={() => toggle("feed")}>
        <SRow label="Enabled" k="feedEnabled" s={s} set={set} />
        <RRow label="Activate Percentage" desc="Per-cycle chance this tool runs at all" minK="feedActivatePctMin" maxK="feedActivatePctMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Delay between actions" minK="actionDelayMin" maxK="actionDelayMax" s={s} set={set} unit="s" />
        <RRow label="Posts to scroll" minK="feedScrollMin" maxK="feedScrollMax" s={s} set={set} />
        <RRow label="Like %" minK="likePercentMin" maxK="likePercentMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Share to Feed %" minK="shareFeedPercentMin" maxK="shareFeedPercentMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Share via DM %" minK="shareDmPercentMin" maxK="shareDmPercentMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Save %" minK="savePercentMin" maxK="savePercentMax" s={s} set={set} unit="%" max={100} />
      </Section>

      {/* View Stories from Feed */}
      <Section icon={BookOpen} title="View Stories from Feed" open={open.stories} onToggle={() => toggle("stories")}>
        <SRow label="Enabled" k="storiesEnabled" s={s} set={set} />
        <RRow label="Activate Percentage" minK="viewStoriesActivatePctMin" maxK="viewStoriesActivatePctMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Stories to watch" minK="viewStoriesSlidesMin" maxK="viewStoriesSlidesMax" s={s} set={set} />
        <RRow label="% to watch per story" minK="viewStoriesSlideWatchPctMin" maxK="viewStoriesSlideWatchPctMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Like %" minK="viewStoriesLikePercentMin" maxK="viewStoriesLikePercentMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Share via DM %" minK="viewStoriesShareDmPercentMin" maxK="viewStoriesShareDmPercentMax" s={s} set={set} unit="%" max={100} />
      </Section>

      {/* View Explore Page */}
      <Section icon={Compass} title="View Explore Page" open={open.explore} onToggle={() => toggle("explore")}>
        <SRow label="Enabled" k="viewExploreEnabled" s={s} set={set} />
        <RRow label="Activate Percentage" minK="viewExploreActivatePctMin" maxK="viewExploreActivatePctMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Posts to scroll" minK="viewExploreScrollMin" maxK="viewExploreScrollMax" s={s} set={set} />
        <RRow label="Delay between actions" minK="viewExploreActionDelayMin" maxK="viewExploreActionDelayMax" s={s} set={set} unit="s" />
        <RRow label="Click posts %" minK="viewExploreClickPostPctMin" maxK="viewExploreClickPostPctMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Like % of posts" minK="viewExploreLikePercentMin" maxK="viewExploreLikePercentMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Share to Feed % of posts" minK="viewExploreShareFeedPercentMin" maxK="viewExploreShareFeedPercentMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Share via DM % of posts" minK="viewExploreShareDmPercentMin" maxK="viewExploreShareDmPercentMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Save % of posts" minK="viewExploreSavePercentMin" maxK="viewExploreSavePercentMax" s={s} set={set} unit="%" max={100} />
      </Section>

      {/* View Reels */}
      <Section icon={Film} title="View Reels" open={open.reels} onToggle={() => toggle("reels")}>
        <SRow label="Enabled" k="viewReelsEnabled" s={s} set={set} />
        <RRow label="Activate Percentage" minK="viewReelsActivatePctMin" maxK="viewReelsActivatePctMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Reels to scroll" minK="viewReelsScrollMin" maxK="viewReelsScrollMax" s={s} set={set} />
        <RRow label="Watch %" minK="viewReelsWatchPctMin" maxK="viewReelsWatchPctMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Like %" minK="viewReelsLikePercentMin" maxK="viewReelsLikePercentMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Share to Feed %" minK="viewReelsShareFeedPercentMin" maxK="viewReelsShareFeedPercentMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Share via DM %" minK="viewReelsShareDmPercentMin" maxK="viewReelsShareDmPercentMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Save %" minK="viewReelsSavePercentMin" maxK="viewReelsSavePercentMax" s={s} set={set} unit="%" max={100} />
      </Section>

      {/* Follow Users */}
      <Section icon={Users} title="Follow Users" open={open.follow} onToggle={() => toggle("follow")}>
        <SRow label="Enabled" k="followEnabled" s={s} set={set} />
        <RRow label="Activate Percentage" minK="followActivatePctMin" maxK="followActivatePctMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Users to follow per session" minK="followUsersMin" maxK="followUsersMax" s={s} set={set} />
        <CRow label="Spread follows" desc="Distribute follows across the cycle instead of back-to-back" k="followSpreadFollows" s={s} set={set} />
      </Section>

      {/* Inject Browsing */}
      <Section icon={Rss} title="Inject Browsing (within Follow)" open={open.injectBrowsing} onToggle={() => toggle("injectBrowsing")}>
        <SRow label="Enabled" k="injectBrowsingEnabled" s={s} set={set} />
        <RRow label="Activate Percentage" minK="injectBrowsingActivatePctMin" maxK="injectBrowsingActivatePctMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Browse before follow %" minK="injectBrowsingBeforeFollowPctMin" maxK="injectBrowsingBeforeFollowPctMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Feed posts to scroll" minK="injectBrowsingFeedMin" maxK="injectBrowsingFeedMax" s={s} set={set} />
        <RRow label="Click post %" minK="injectBrowsingClickPostPctMin" maxK="injectBrowsingClickPostPctMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Like %" minK="injectBrowsingLikePctMin" maxK="injectBrowsingLikePctMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Share to Feed %" minK="injectBrowsingShareFeedPctMin" maxK="injectBrowsingShareFeedPctMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Share via DM %" minK="injectBrowsingShareDmPctMin" maxK="injectBrowsingShareDmPctMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Save post %" minK="injectBrowsingSavePostPctMin" maxK="injectBrowsingSavePostPctMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Abandon follow %" minK="injectBrowsingAbandonFollowPctMin" maxK="injectBrowsingAbandonFollowPctMax" s={s} set={set} unit="%" max={100} />
      </Section>

      {/* Follow Filters */}
      <Section icon={Users} title="Follow Filters" open={open.followFilters} onToggle={() => toggle("followFilters")}>
        <SRow label="Enabled" desc="Apply profile-quality gates before each follow" k="followFiltersEnabled" s={s} set={set} />
        <CRow label="Skip private accounts" k="followFilterPrivateUsers" s={s} set={set} />
        <CRow label="Skip non-English speaking" k="followFilterEnglishSpeaking" s={s} set={set} />
        <CRow label="Skip accounts with &lt; 50 followers" k="followFilterMinFollowers50" s={s} set={set} />
        <CRow label="Skip verified accounts" k="followFilterVerifiedUsers" s={s} set={set} />
        <CRow label="Skip accounts with &gt; 25k followers" k="followFilterMaxFollowers25k" s={s} set={set} />
      </Section>

      {/* Random Jitter */}
      <Section icon={Bell} title="Random Jitter" open={open.jitter} onToggle={() => toggle("jitter")}>
        <SRow label="Enabled" desc="Human-like interstitial actions fired probabilistically each cycle" k="randomJitterEnabled" s={s} set={set} />
        <RRow label="Activate Percentage" minK="randomJitterActivatePctMin" maxK="randomJitterActivatePctMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Check Notifications %" minK="checkNotificationsPctMin" maxK="checkNotificationsPctMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Notification scrolls" minK="checkNotificationsScrollsMin" maxK="checkNotificationsScrollsMax" s={s} set={set} />
        <RRow label="Notification click %" minK="checkNotificationsClickPctMin" maxK="checkNotificationsClickPctMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Visit Profile %" minK="visitProfilePctMin" maxK="visitProfilePctMax" s={s} set={set} unit="%" max={100} />
      </Section>

      {/* Make a Post */}
      <Section icon={ImagePlus} title="Make a Post" open={open.makePost} onToggle={() => toggle("makePost")}>
        <SRow label="Enabled" k="makePostEnabled" s={s} set={set} />
        <RRow label="Activate Percentage" minK="makePostActivatePctMin" maxK="makePostActivatePctMax" s={s} set={set} unit="%" max={100} />
        <RRow label="Posts per session" minK="makePostPerSessionMin" maxK="makePostPerSessionMax" s={s} set={set} />

        {/* Source — Instagram Account */}
        <CRow label="Source: Instagram account" desc="Pull posts from a username via HikerAPI" k="makePostDisableUsernameSource"
          s={{ ...s, makePostDisableUsernameSource: !s.makePostDisableUsernameSource }}
          set={(k, v) => set("makePostDisableUsernameSource", !(v as boolean))}
        />
        {!s.makePostDisableUsernameSource && (
          <TRow label="Source username" k="makePostSourceUsername" s={s} set={set} placeholder="@username" />
        )}
        <SRow label="Use HikerAPI" k="makePostUseHikerApi" s={s} set={set} />

        {/* Source — Local Folder */}
        <SRow label="Source: local folder" k="makePostLocalFolderEnabled" s={s} set={set} />
        {s.makePostLocalFolderEnabled && <>
          <TRow label="Folder path" k="makePostLocalFolderPath" s={s} set={set} placeholder="C:\path\to\folder" />
          <CRow label="No repeat" k="makePostLocalFolderNoRepeat" s={s} set={set} />
          <CRow label="Pick at random" k="makePostLocalFolderRandom" s={s} set={set} />
          <CRow label="Delete after upload" k="makePostLocalFolderDeleteAfterUpload" s={s} set={set} />
        </>}

        {/* Caption */}
        <SRow label="Use ChatGPT for caption" k="makePostUseChatGpt" s={s} set={set} />
        <SRow label="Fix AI slop" k="makePostFixAiSlop" s={s} set={set} />
        <SRow label="Make it unique" k="makePostMakeUnique" s={s} set={set} />
        <Row label="Caption text" right={
          <textarea
            value={s.makePostCaptionText}
            onChange={e => set("makePostCaptionText", e.target.value)}
            placeholder="Caption…"
            rows={2}
            className="w-48 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary resize-none"
          />
        } />

        {/* Alteration */}
        <SRow label="Alteration enabled" k="makePostAlterationEnabled" s={s} set={set} />
        <Row label="Alteration level" right={
          <select
            value={s.makePostAlterationLevel}
            onChange={e => set("makePostAlterationLevel", e.target.value as "small" | "medium" | "high")}
            className="h-7 rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-primary"
          >
            {(["small", "medium", "high"] as const).map(v => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        } />

        {/* Image settings */}
        <Row label="Image settings" right={
          <div className="flex items-center gap-2">
            <Switch
              checked={s.makePostImageSettingsEnabled}
              onCheckedChange={v => set("makePostImageSettingsEnabled", v)}
            />
            <button
              type="button"
              disabled={!s.makePostImageSettingsEnabled}
              onClick={() => setImageSettingsOpen(true)}
              className="text-xs px-3 h-7 rounded-md border border-border bg-background hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Configure…
            </button>
          </div>
        } />

        {/* Limits */}
        <NRow label="Disable at post count" desc="Stop posting once this many posts are published (0 = unlimited)" k="makePostDisableAtPostCount" s={s} set={set} />
        <SRow label="Disable when source exhausted" k="makePostDisableWhenExhausted" s={s} set={set} />
      </Section>

      {/* Image settings dialog */}
      <ImageSettingsDialog
        open={imageSettingsOpen}
        onClose={() => setImageSettingsOpen(false)}
        settings={s.makePostImageSettings}
        alterationLevel={s.makePostAlterationLevel}
        onSave={saved => set("makePostImageSettings", saved)}
      />

    </div>
  );
}
