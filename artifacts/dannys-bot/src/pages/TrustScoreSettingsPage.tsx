import { useState, useCallback } from "react";
import { useRoute, useLocation } from "wouter";
import { Switch } from "@/components/ui/switch";
import { getTrustLevels, type TrustLevelEntry } from "@/components/TrustScoreBadge";
import {
  ArrowLeft, Clock, PlaySquare, Compass, Film,
  MessageSquare, Repeat2, Globe, Bell, Zap,
  ChevronDown, ChevronUp, Settings, BookOpen,
} from "lucide-react";

// ── Storage ───────────────────────────────────────────────────────────────────
// Completely isolated from device slots, profiles, and the Human Session Tool.
// Each trust score ID has its own localStorage key.

const LS_KEY = (id: string) => `ts_hs_settings_v1_${id}`;

// All boolean fields default to true; all numeric fields default to 0.
const DEFAULTS = {
  // General
  randomiseTiming: true,
  delayMin: 0, delayMax: 0,
  // Timeline Feed
  viewTimelineFeedEnabled: true,
  viewTimelineFeedMin: 0, viewTimelineFeedMax: 0,
  viewTimelineFeedOrderMin: 0, viewTimelineFeedOrderMax: 0,
  viewTimelineFeedNotUsedMin: 0, viewTimelineFeedNotUsedMax: 0,
  likeTimelinePostsPercentMin: 0, likeTimelinePostsPercentMax: 0,
  likeTimelinePostsDelayMin: 0, likeTimelinePostsDelayMax: 0,
  saveMediaEnabled: true, saveMediaPercent: 0,
  sharePostPercentMin: 0, sharePostPercentMax: 0,
  expandCaptionPercentMin: 0, expandCaptionPercentMax: 0,
  viewPostProfilePercentMin: 0, viewPostProfilePercentMax: 0,
  viewProfileFeedPercentMin: 0, viewProfileFeedPercentMax: 0,
  viewProfileFeedCountMin: 0, viewProfileFeedCountMax: 0,
  viewProfilePostsPercentMin: 0, viewProfilePostsPercentMax: 0,
  viewProfilePostsCountMin: 0, viewProfilePostsCountMax: 0,
  // Explore Page
  followSuggestedUsersIfEmptyEnabled: true,
  explorePageOrderMin: 0, explorePageOrderMax: 0,
  explorePageSkipMin: 0, explorePageSkipMax: 0,
  exploreScrollMin: 0, exploreScrollMax: 0,
  exploreClickMin: 0, exploreClickMax: 0,
  exploreLikePctMin: 0, exploreLikePctMax: 0,
  exploreVisitProfilePctMin: 0, exploreVisitProfilePctMax: 0,
  exploreProfileScrollMin: 0, exploreProfileScrollMax: 0,
  exploreProfileClickMin: 0, exploreProfileClickMax: 0,
  // View Reels
  viewReelsEnabled: true,
  viewReelsOrderMin: 0, viewReelsOrderMax: 0,
  reelWatchChanceMin: 0, reelWatchChanceMax: 0,
  reelWatchCountMin: 0, reelWatchCountMax: 0,
  reelWatchPercentMin: 0, reelWatchPercentMax: 0,
  reelLikePercentMin: 0, reelLikePercentMax: 0,
  viewReelsNotUsedMin: 0, viewReelsNotUsedMax: 0,
  // Random Actions
  humanSessionEnabled: true,
  humanSessionOrderMin: 0, humanSessionOrderMax: 0,
  humanSessionNotUsedMin: 0, humanSessionNotUsedMax: 0,
  notificationsRunChanceMin: 0, notificationsRunChanceMax: 0,
  ownProfileRunChanceMin: 0, ownProfileRunChanceMax: 0,
  settingsActivityRunChanceMin: 0, settingsActivityRunChanceMax: 0,
  viewActivityRunChanceMin: 0, viewActivityRunChanceMax: 0,
  viewSavedRunChanceMin: 0, viewSavedRunChanceMax: 0,
  // Check Stories
  checkTimelineStoriesEnabled: true,
  checkTimelineStoriesMin: 0, checkTimelineStoriesMax: 0,
  checkTimelineStoriesOrderMin: 0, checkTimelineStoriesOrderMax: 0,
  checkTimelineStoriesNotUsedMin: 0, checkTimelineStoriesNotUsedMax: 0,
  storyLikePctMin: 0, storyLikePctMax: 0,
  storySharePctMin: 0, storySharePctMax: 0,
  // Check DMs
  checkDmEnabled: true,
  checkDmMin: 0, checkDmMax: 0,
  checkDmOrderMin: 0, checkDmOrderMax: 0,
  checkDmNotUsedMin: 0, checkDmNotUsedMax: 0,
  // Repost
  repostEnabled: true,
  repostSourceUsername: "",
  repostDisableUsernameSource: true,
  repostUseHikerApi: true,
  repostLocalFolderEnabled: true,
  repostLocalFolderPath: "",
  repostLocalFolderDeleteAfterUpload: true,
  repostLocalFolderNoRepeat: true,
  repostLocalFolderRandom: true,
  repostMin: 0, repostMax: 0,
  repostAlterationLevel: "small",
  repostMakeUnique: true,
  repostUseChatGpt: true,
  repostCaptionText: "",
  repostDisableComments: true,
  repostOrderMin: 0, repostOrderMax: 0,
  repostNotUsedMin: 0, repostNotUsedMax: 0,
  repostDisableAtPostCount: 0,
  repostDisableWhenExhausted: true,
  // Force Emulation
  forceEmulationEnabled: true,
  forceEmulationRandomise: true,
  // Web Browsing
  webBrowsingEnabled: true,
  webBrowsingOrderMin: 0, webBrowsingOrderMax: 0,
  webBrowsingSkipMin: 0, webBrowsingSkipMax: 0,
  webBrowsingVisitRandom: true,
  webBrowsingSites: "",
  webBrowsingSitesMin: 0, webBrowsingSitesMax: 0,
  webBrowsingInternalLinksMin: 0, webBrowsingInternalLinksMax: 0,
  webBrowsingTimeOnSiteMin: 0, webBrowsingTimeOnSiteMax: 0,
  webBrowsingTimeOnLinksMin: 0, webBrowsingTimeOnLinksMax: 0,
  // Embedded Tool Execution Order (where Follow/Unfollow/Contact run within a session)
  followOrderMin: 0, followOrderMax: 0,
  followSkipMin: 0, followSkipMax: 0,
  unfollowOrderMin: 0, unfollowOrderMax: 0,
  unfollowSkipMin: 0, unfollowSkipMax: 0,
  contactOrderMin: 0, contactOrderMax: 0,
  contactSkipMin: 0, contactSkipMax: 0,
};

type HsSettings = typeof DEFAULTS;
type Setter = (key: keyof HsSettings, value: HsSettings[keyof HsSettings]) => void;

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

// ── Shared row primitives ─────────────────────────────────────────────────────

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
      <Switch checked={!!s[k]} onCheckedChange={v => set(k, v)} />
    } />
  );
}

function RRow({ label, minK, maxK, s, set, unit }: {
  label: string; minK: keyof HsSettings; maxK: keyof HsSettings;
  s: HsSettings; set: Setter; unit?: string;
}) {
  return (
    <Row label={label} right={
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          value={s[minK] as number}
          min={0}
          onChange={e => set(minK, Math.max(0, Number(e.target.value)))}
          className="w-16 h-7 rounded-md border border-border bg-background px-2 text-xs text-center outline-none focus:ring-1 focus:ring-primary"
        />
        <span className="text-xs text-muted-foreground">–</span>
        <input
          type="number"
          value={s[maxK] as number}
          min={0}
          onChange={e => set(maxK, Math.max(0, Number(e.target.value)))}
          className="w-16 h-7 rounded-md border border-border bg-background px-2 text-xs text-center outline-none focus:ring-1 focus:ring-primary"
        />
        {unit && <span className="text-[11px] text-muted-foreground w-6">{unit}</span>}
      </div>
    } />
  );
}

function NRow({ label, k, s, set, unit }: { label: string; k: keyof HsSettings; s: HsSettings; set: Setter; unit?: string }) {
  return (
    <Row label={label} right={
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          value={s[k] as number}
          min={0}
          onChange={e => set(k, Math.max(0, Number(e.target.value)))}
          className="w-20 h-7 rounded-md border border-border bg-background px-2 text-xs text-center outline-none focus:ring-1 focus:ring-primary"
        />
        {unit && <span className="text-[11px] text-muted-foreground">{unit}</span>}
      </div>
    } />
  );
}

function TRow({ label, k, s, set, placeholder }: { label: string; k: keyof HsSettings; s: HsSettings; set: Setter; placeholder?: string }) {
  return (
    <Row label={label} right={
      <input
        type="text"
        value={s[k] as string}
        onChange={e => set(k, e.target.value)}
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

  const [open, setOpen] = useState<Record<string, boolean>>({
    general: true, feed: true, explore: false, reels: false,
    actions: false, stories: false, dms: false, repost: false,
    webBrowsing: false, forceEmulation: false, toolOrder: false,
  });
  const toggle = (key: string) => setOpen(prev => ({ ...prev, [key]: !prev[key] }));

  const set: Setter = useCallback((key, value) => {
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
          <h1 className="text-base font-bold leading-tight">Human Session Settings</h1>
          <p className="text-xs text-muted-foreground">Isolated per trust score — not linked to any device slot, profile, or Human Session Tool.</p>
        </div>
      </div>

      {/* General */}
      <Section icon={Clock} title="General" open={open.general} onToggle={() => toggle("general")}>
        <SRow label="Randomise timing" desc="Stagger each account's start across the delay window" k="randomiseTiming" s={s} set={set} />
        <RRow label="Session delay range" minK="delayMin" maxK="delayMax" s={s} set={set} unit="s" />
      </Section>

      {/* Timeline Feed */}
      <Section icon={PlaySquare} title="View Timeline Feed" open={open.feed} onToggle={() => toggle("feed")}>
        <SRow label="Enabled" k="viewTimelineFeedEnabled" s={s} set={set} />
        <RRow label="Posts per session" minK="viewTimelineFeedMin" maxK="viewTimelineFeedMax" s={s} set={set} />
        <RRow label="Execution order" minK="viewTimelineFeedOrderMin" maxK="viewTimelineFeedOrderMax" s={s} set={set} />
        <RRow label="Skip chance" minK="viewTimelineFeedNotUsedMin" maxK="viewTimelineFeedNotUsedMax" s={s} set={set} unit="%" />
        <RRow label="% posts to like" minK="likeTimelinePostsPercentMin" maxK="likeTimelinePostsPercentMax" s={s} set={set} unit="%" />
        <RRow label="Delay between likes" minK="likeTimelinePostsDelayMin" maxK="likeTimelinePostsDelayMax" s={s} set={set} unit="s" />
        <SRow label="Save liked media" k="saveMediaEnabled" s={s} set={set} />
        <NRow label="Save media %" k="saveMediaPercent" s={s} set={set} unit="%" />
        <RRow label="Share post %" minK="sharePostPercentMin" maxK="sharePostPercentMax" s={s} set={set} unit="%" />
        <RRow label="Expand caption %" minK="expandCaptionPercentMin" maxK="expandCaptionPercentMax" s={s} set={set} unit="%" />
        <RRow label="Visit profile %" minK="viewPostProfilePercentMin" maxK="viewPostProfilePercentMax" s={s} set={set} unit="%" />
        <RRow label="View profile feed %" minK="viewProfileFeedPercentMin" maxK="viewProfileFeedPercentMax" s={s} set={set} unit="%" />
        <RRow label="View profile feed count" minK="viewProfileFeedCountMin" maxK="viewProfileFeedCountMax" s={s} set={set} />
        <RRow label="Open profile posts %" minK="viewProfilePostsPercentMin" maxK="viewProfilePostsPercentMax" s={s} set={set} unit="%" />
        <RRow label="Open profile posts count" minK="viewProfilePostsCountMin" maxK="viewProfilePostsCountMax" s={s} set={set} />
      </Section>

      {/* Explore */}
      <Section icon={Compass} title="Visit Explore Page" open={open.explore} onToggle={() => toggle("explore")}>
        <SRow label="Enabled" k="followSuggestedUsersIfEmptyEnabled" s={s} set={set} />
        <RRow label="Execution order" minK="explorePageOrderMin" maxK="explorePageOrderMax" s={s} set={set} />
        <RRow label="Skip chance" minK="explorePageSkipMin" maxK="explorePageSkipMax" s={s} set={set} unit="%" />
        <RRow label="Posts to scroll" minK="exploreScrollMin" maxK="exploreScrollMax" s={s} set={set} />
        <RRow label="Posts to click" minK="exploreClickMin" maxK="exploreClickMax" s={s} set={set} />
        <RRow label="Like %" minK="exploreLikePctMin" maxK="exploreLikePctMax" s={s} set={set} unit="%" />
        <RRow label="Visit author profile %" minK="exploreVisitProfilePctMin" maxK="exploreVisitProfilePctMax" s={s} set={set} unit="%" />
        <RRow label="Posts to scroll on profile" minK="exploreProfileScrollMin" maxK="exploreProfileScrollMax" s={s} set={set} />
        <RRow label="Posts to click on profile" minK="exploreProfileClickMin" maxK="exploreProfileClickMax" s={s} set={set} />
      </Section>

      {/* Reels */}
      <Section icon={Film} title="View Reels" open={open.reels} onToggle={() => toggle("reels")}>
        <SRow label="Enabled" k="viewReelsEnabled" s={s} set={set} />
        <RRow label="Execution order" minK="viewReelsOrderMin" maxK="viewReelsOrderMax" s={s} set={set} />
        <RRow label="Run chance" minK="reelWatchChanceMin" maxK="reelWatchChanceMax" s={s} set={set} unit="%" />
        <RRow label="Reels to watch" minK="reelWatchCountMin" maxK="reelWatchCountMax" s={s} set={set} />
        <RRow label="% of each reel to watch" minK="reelWatchPercentMin" maxK="reelWatchPercentMax" s={s} set={set} unit="%" />
        <RRow label="% of reels to like" minK="reelLikePercentMin" maxK="reelLikePercentMax" s={s} set={set} unit="%" />
        <RRow label="Skip chance" minK="viewReelsNotUsedMin" maxK="viewReelsNotUsedMax" s={s} set={set} unit="%" />
      </Section>

      {/* Random Actions */}
      <Section icon={Bell} title="Random Actions" open={open.actions} onToggle={() => toggle("actions")}>
        <SRow label="Enabled" k="humanSessionEnabled" s={s} set={set} />
        <RRow label="Execution order" minK="humanSessionOrderMin" maxK="humanSessionOrderMax" s={s} set={set} />
        <RRow label="Skip chance" minK="humanSessionNotUsedMin" maxK="humanSessionNotUsedMax" s={s} set={set} unit="%" />
        <RRow label="Notifications run chance" minK="notificationsRunChanceMin" maxK="notificationsRunChanceMax" s={s} set={set} unit="%" />
        <RRow label="Own Profile run chance" minK="ownProfileRunChanceMin" maxK="ownProfileRunChanceMax" s={s} set={set} unit="%" />
        <RRow label="Settings run chance" minK="settingsActivityRunChanceMin" maxK="settingsActivityRunChanceMax" s={s} set={set} unit="%" />
        <RRow label="View Activity run chance" minK="viewActivityRunChanceMin" maxK="viewActivityRunChanceMax" s={s} set={set} unit="%" />
        <RRow label="View Saved run chance" minK="viewSavedRunChanceMin" maxK="viewSavedRunChanceMax" s={s} set={set} unit="%" />
      </Section>

      {/* Stories */}
      <Section icon={BookOpen} title="Check Timeline Stories" open={open.stories} onToggle={() => toggle("stories")}>
        <SRow label="Enabled" k="checkTimelineStoriesEnabled" s={s} set={set} />
        <RRow label="Stories per session" minK="checkTimelineStoriesMin" maxK="checkTimelineStoriesMax" s={s} set={set} />
        <RRow label="Execution order" minK="checkTimelineStoriesOrderMin" maxK="checkTimelineStoriesOrderMax" s={s} set={set} />
        <RRow label="Skip chance" minK="checkTimelineStoriesNotUsedMin" maxK="checkTimelineStoriesNotUsedMax" s={s} set={set} unit="%" />
        <RRow label="Like %" minK="storyLikePctMin" maxK="storyLikePctMax" s={s} set={set} unit="%" />
        <RRow label="Share %" minK="storySharePctMin" maxK="storySharePctMax" s={s} set={set} unit="%" />
      </Section>

      {/* DMs */}
      <Section icon={MessageSquare} title="Check DMs" open={open.dms} onToggle={() => toggle("dms")}>
        <SRow label="Enabled" k="checkDmEnabled" s={s} set={set} />
        <RRow label="DMs per session" minK="checkDmMin" maxK="checkDmMax" s={s} set={set} />
        <RRow label="Execution order" minK="checkDmOrderMin" maxK="checkDmOrderMax" s={s} set={set} />
        <RRow label="Skip chance" minK="checkDmNotUsedMin" maxK="checkDmNotUsedMax" s={s} set={set} unit="%" />
      </Section>

      {/* Repost */}
      <Section icon={Repeat2} title="Repost" open={open.repost} onToggle={() => toggle("repost")}>
        <SRow label="Enabled" k="repostEnabled" s={s} set={set} />
        <TRow label="Source account username" k="repostSourceUsername" s={s} set={set} placeholder="@username" />
        <SRow label="Disable username source" k="repostDisableUsernameSource" s={s} set={set} />
        <SRow label="Use HikerAPI" k="repostUseHikerApi" s={s} set={set} />
        <SRow label="Local folder enabled" k="repostLocalFolderEnabled" s={s} set={set} />
        <TRow label="Local folder path" k="repostLocalFolderPath" s={s} set={set} placeholder="C:\path\to\folder" />
        <SRow label="Delete after upload" k="repostLocalFolderDeleteAfterUpload" s={s} set={set} />
        <SRow label="No repeat" k="repostLocalFolderNoRepeat" s={s} set={set} />
        <SRow label="Random from folder" k="repostLocalFolderRandom" s={s} set={set} />
        <RRow label="Posts per session" minK="repostMin" maxK="repostMax" s={s} set={set} />
        <Row label="Alteration level" right={
          <select
            value={s.repostAlterationLevel}
            onChange={e => set("repostAlterationLevel", e.target.value)}
            className="h-7 rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-primary"
          >
            {["none", "small", "medium", "large", "extreme"].map(v => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        } />
        <SRow label="Make it unique" k="repostMakeUnique" s={s} set={set} />
        <SRow label="Use ChatGPT for caption" k="repostUseChatGpt" s={s} set={set} />
        <Row label="Caption text" right={
          <textarea
            value={s.repostCaptionText}
            onChange={e => set("repostCaptionText", e.target.value)}
            placeholder="Caption…"
            rows={2}
            className="w-48 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary resize-none"
          />
        } />
        <SRow label="Disable comments" k="repostDisableComments" s={s} set={set} />
        <RRow label="Execution order" minK="repostOrderMin" maxK="repostOrderMax" s={s} set={set} />
        <RRow label="Skip chance" minK="repostNotUsedMin" maxK="repostNotUsedMax" s={s} set={set} unit="%" />
        <NRow label="Disable at post count" k="repostDisableAtPostCount" s={s} set={set} />
        <SRow label="Disable when exhausted" k="repostDisableWhenExhausted" s={s} set={set} />
      </Section>

      {/* Force Emulation */}
      <Section icon={Zap} title="Force Emulation" open={open.forceEmulation} onToggle={() => toggle("forceEmulation")}>
        <SRow label="Enabled" k="forceEmulationEnabled" s={s} set={set} />
        <SRow label="Randomise" k="forceEmulationRandomise" s={s} set={set} />
      </Section>

      {/* Web Browsing */}
      <Section icon={Globe} title="Web Browsing" open={open.webBrowsing} onToggle={() => toggle("webBrowsing")}>
        <SRow label="Enabled" k="webBrowsingEnabled" s={s} set={set} />
        <RRow label="Execution order" minK="webBrowsingOrderMin" maxK="webBrowsingOrderMax" s={s} set={set} />
        <RRow label="Skip chance" minK="webBrowsingSkipMin" maxK="webBrowsingSkipMax" s={s} set={set} unit="%" />
        <SRow label="Visit websites at random" k="webBrowsingVisitRandom" s={s} set={set} />
        <Row label="Website URLs" right={
          <textarea
            value={s.webBrowsingSites}
            onChange={e => set("webBrowsingSites", e.target.value)}
            placeholder={"https://example.com\nhttps://another.com"}
            rows={3}
            className="w-52 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary resize-none font-mono"
          />
        } />
        <RRow label="Sites to visit" minK="webBrowsingSitesMin" maxK="webBrowsingSitesMax" s={s} set={set} />
        <RRow label="Internal links" minK="webBrowsingInternalLinksMin" maxK="webBrowsingInternalLinksMax" s={s} set={set} />
        <RRow label="Time on site" minK="webBrowsingTimeOnSiteMin" maxK="webBrowsingTimeOnSiteMax" s={s} set={set} unit="min" />
        <RRow label="Time on internal links" minK="webBrowsingTimeOnLinksMin" maxK="webBrowsingTimeOnLinksMax" s={s} set={set} unit="min" />
      </Section>

      {/* Embedded Tool Order */}
      <Section icon={Settings} title="Embedded Tool Execution Order" open={open.toolOrder} onToggle={() => toggle("toolOrder")}>
        <p className="text-xs text-muted-foreground py-2 border-b border-border/40">
          Controls where Follow, Unfollow, and Contact tools run within a Human Session.
        </p>
        <RRow label="Follow — Execution order" minK="followOrderMin" maxK="followOrderMax" s={s} set={set} />
        <RRow label="Follow — Skip chance" minK="followSkipMin" maxK="followSkipMax" s={s} set={set} unit="%" />
        <RRow label="Unfollow — Execution order" minK="unfollowOrderMin" maxK="unfollowOrderMax" s={s} set={set} />
        <RRow label="Unfollow — Skip chance" minK="unfollowSkipMin" maxK="unfollowSkipMax" s={s} set={set} unit="%" />
        <RRow label="Contact — Execution order" minK="contactOrderMin" maxK="contactOrderMax" s={s} set={set} />
        <RRow label="Contact — Skip chance" minK="contactSkipMin" maxK="contactSkipMax" s={s} set={set} unit="%" />
      </Section>

    </div>
  );
}
