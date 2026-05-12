import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Activity, Clock, User, Zap, Sparkles, Bell, Search, ChevronDown, ChevronUp, X, RefreshCw, Settings2, Upload,
} from "lucide-react";
import { format } from "date-fns";
import { type Profile } from "@shared/schema";

type Tab = "api-log" | "whats-new";

const ERROR_ACTIONS = new Set([
  "verification_failed", "follow_blocked", "unfollow_blocked",
  "dm_blocked", "contact_dm_blocked", "logged_out",
]);

const ACTION_STYLES: Record<string, { label: string; cls: string; icon: string }> = {
  tool_start:              { label: "Started",         cls: "bg-blue-100 text-blue-700",      icon: "▶" },
  tool_complete:           { label: "Complete",        cls: "bg-emerald-100 text-emerald-700", icon: "✓" },
  verified:                { label: "Verified",        cls: "bg-green-100 text-green-700",    icon: "✓" },
  verification_failed:     { label: "Verify Fail",     cls: "bg-red-100 text-red-700",        icon: "✗" },
  follow:                  { label: "Follow",          cls: "bg-sky-100 text-sky-700",        icon: "+" },
  follow_blocked:          { label: "Blocked",         cls: "bg-rose-100 text-rose-700",      icon: "⊘" },
  follow_skipped:          { label: "Skipped",         cls: "bg-orange-100 text-orange-700",  icon: "⇥" },
  dedup_skip:              { label: "Skipped",         cls: "bg-amber-100 text-amber-700",    icon: "⇥" },
  filter_skip:             { label: "Filter Skip",     cls: "bg-yellow-100 text-yellow-800",  icon: "⊘" },
  unfollow:                { label: "Unfollow",        cls: "bg-violet-100 text-violet-700",  icon: "−" },
  unfollow_blocked:        { label: "UF Block",        cls: "bg-pink-100 text-pink-700",      icon: "⊘" },
  dm:                      { label: "DM",              cls: "bg-purple-100 text-purple-700",  icon: "✉" },
  dm_blocked:              { label: "DM Block",        cls: "bg-fuchsia-100 text-fuchsia-700",icon: "⊘" },
  contact_dm_blocked:      { label: "Contact Block",   cls: "bg-indigo-100 text-indigo-700",  icon: "⊘" },
  no_sources:              { label: "No Sources",      cls: "bg-slate-100 text-slate-600",    icon: "⚠" },
  logged_out:              { label: "Logged Out",      cls: "bg-red-100 text-red-700",        icon: "⚠" },
  account_imported:        { label: "EQX Import",      cls: "bg-blue-100 text-blue-700",      icon: "↓" },
  account_exported:        { label: "EQX Export",      cls: "bg-cyan-100 text-cyan-700",      icon: "↑" },
  view_timeline_feed:      { label: "Timeline Feed",   cls: "bg-teal-100 text-teal-700",      icon: "≡" },
  like_timeline_post:      { label: "Timeline Like",   cls: "bg-rose-100 text-rose-600",      icon: "♥" },
  check_timeline_reels:    { label: "Watch Reels",     cls: "bg-orange-100 text-orange-700",  icon: "▶" },
  check_timeline_stories:  { label: "Watch Stories",   cls: "bg-amber-100 text-amber-700",    icon: "◎" },
  visit_notifications:     { label: "Notifications",   cls: "bg-sky-100 text-sky-600",        icon: "🔔" },
  visit_own_profile:       { label: "Own Profile",     cls: "bg-indigo-100 text-indigo-600",  icon: "◉" },
  refresh_own_profile:     { label: "Refresh Profile", cls: "bg-indigo-100 text-indigo-600",  icon: "↺" },
  visit_settings_activity: { label: "Settings",        cls: "bg-slate-100 text-slate-600",    icon: "⚙" },
  save_media:              { label: "Save Media",      cls: "bg-emerald-100 text-emerald-600", icon: "⊙" },
};

const DEFAULT_COL_WIDTHS = { account: 160, event: 150, target: 100, detail: 200, timestamp: 220 };

const CHANGELOG: { version: string; date: string; items: { category: string; text: string }[] }[] = [
  {
    version: "1.0.258",
    date: "13 May 2026, 01:30",
    items: [
      { category: "Dashboard", text: "Event icons now appear after the event name, not before — e.g. 'TIMELINE LIKE ♥' instead of '♥ TIMELINE LIKE'." },
      { category: "Human Sessions", text: "Fixed: When an account has no stored igApiCookies (mobile API session), the engine now automatically attempts a fresh mobile login using the account's stored credentials. On success, the resulting session cookies are immediately saved back to the database as igApiCookies — so the account is permanently mobile-API-enabled and subsequent sessions restore instantly without re-logging in. Previously these cookies were only held in memory and lost on every restart, forcing a new login attempt each time." },
      { category: "Human Sessions", text: "Fixed: Mobile login failures now produce a clear server log — 'Mobile-API tools (Watch Reels, Watch Stories) will be skipped this session' — instead of a silent transient error, so you know exactly which tools are affected when a session can't establish mobile API cookies." },
    ],
  },
  {
    version: "1.0.257",
    date: "13 May 2026, 01:00",
    items: [
      { category: "Dashboard", text: "Each event in the activity feed now has its own icon inside the coloured badge. Heart (♥) for Timeline Like, play (▶) for Watch Reels and Started, checkmark (✓) for Verified/Complete, plus (⊕) for Follow, minus (−) for Unfollow, envelope (✉) for DM, bell (🔔) for Notifications, and more. All 29 action types now have distinct icons." },
      { category: "Human Sessions", text: "Fixed: Watch Reels no longer shows 'Skipped: no mobile session' without explanation. The engine now checks isMobileLoggedIn() before attempting to call the clips feed and logs the exact reason — either 'No igApiCookies stored for this account' (needs Verify Credentials run) or 'igApiCookies found but session failed to restore — cookies may be expired' — so you know exactly what action to take." },
      { category: "Human Sessions", text: "Debug: Added explicit ENQUEUE FIRED trace logs to the server console for both the standalone Like Timeline Posts block and the inline like-% block inside View Timeline Feed. When likes happen unexpectedly, the server log will now show exactly which code path triggered them (STANDALONE vs INLINE LIKE%) so the source can be identified immediately." },
    ],
  },
  {
    version: "1.0.256",
    date: "13 May 2026, 00:30",
    items: [
      { category: "Security", text: "Fixed: Embedded browser is now blocked when an account has no proxy assigned. Attempting to open the EB without a proxy returns an error — 'No proxy assigned — assign a proxy to this account before using the embedded browser.' Both the browser start and stream routes are guarded." },
      { category: "Human Sessions", text: "Fixed: Watch Reels returning 0 now logs a warning in the activity feed — '0 reels in clips feed — check server log for response details' — instead of a silent ok. The server console also prints the full response body (first 500 chars) so the exact Instagram response can be inspected." },
      { category: "UI", text: "COPY SETTINGS button text is now uppercase across all tool panels: Human Sessions, Follow, Unfollow, Contact, Create Cookie, and the Copy Settings dialog confirm button." },
    ],
  },
  {
    version: "1.0.255",
    date: "13 May 2026, 00:00",
    items: [
      { category: "Human Sessions", text: "Fixed: Watch Reels now correctly detects when there is no mobile session (igApiCookies missing) and logs a clear warning — 'Skipped: no mobile session — run Verify Credentials' — instead of silently reporting 'Watched 0 reels' with an ok status." },
      { category: "Human Sessions", text: "Fixed: 'Viewed 0 reels' no longer appears in the API calls log when reels are skipped due to no session or an empty feed. The API log entry is suppressed entirely when count is 0 — only successful views are recorded." },
      { category: "Human Sessions", text: "Debug: First item structure from /api/v1/clips/feed/ is now printed to the server console whenever reels are fetched, so any future response-shape changes can be diagnosed immediately without code changes." },
    ],
  },
  {
    version: "1.0.254",
    date: "12 May 2026, 23:30",
    items: [
      { category: "Human Sessions", text: "Fixed: Like % from View Timeline Feed no longer likes reels. When the home timeline contains a reel, it is now marked as seen (natural scroll behaviour) but skipped for liking — only standard photo/video posts are liked. This eliminates the crossover between the like percentage selector and the Watch Reels tool." },
      { category: "Human Sessions", text: "Fixed: Watch Reels from Timeline showed Viewed 0 Reels in the API log. The clips feed response key fallback now covers both 'items' and 'feed_items' response shapes, and debug logging has been added so the exact response structure is visible in the server log if it happens again." },
    ],
  },
  {
    version: "1.0.253",
    date: "12 May 2026, 23:00",
    items: [
      { category: "Dashboard", text: "Fixed: Profile Import notification no longer stays pinned at the top of the activity log — it is now inserted at its correct timestamp and sorts chronologically alongside all other events." },
      { category: "Dashboard", text: "Added missing ACTION_STYLES labels for: EQX Import, EQX Export, Timeline Feed, Timeline Like, Watch Reels, Watch Stories, Notifications, Own Profile, Refresh Profile, Settings, Save Media — all now show with distinct coloured badges instead of the generic grey fallback." },
      { category: "Human Sessions", text: "Confirmed: Check Reels from Timeline has no wiring crossover with View Timeline Feed. It correctly uses /api/v1/clips/feed/ (the Reels tab endpoint) and sends a single batch /api/v1/media/seen/ call for all reels — 1 API call for multiple reels, exactly as Instagram's mobile app fires them. ViewTimelineFeedSeen is a separate signal from viewTimelineFeed (home feed)." },
    ],
  },
  {
    version: "1.0.252",
    date: "12 May 2026, 22:30",
    items: [
      { category: "EQX Export", text: "Fixed: exporting multiple EQX files no longer silently does nothing — removed reliance on the showDirectoryPicker API (which fails in Electron and proxied iframe environments) and replaced with reliable sequential browser downloads for all multi-account exports." },
      { category: "EQX Import", text: "Fixed: Follow tool target sources are now correctly restored on import — sources are now inserted in a separate step from settings with their own error handling, and any null/invalid source rows are filtered out before the bulk insert to prevent silent failures." },
      { category: "UI", text: "BACK TO ACCOUNTS and DASH navigation links are now displayed in uppercase for better visual distinction." },
      { category: "UI", text: "Sidebar submenu items (Follow Tool, Unfollow Tool, etc.) are now displayed in bold." },
    ],
  },
  {
    version: "1.0.251",
    date: "12 May 2026, 22:00",
    items: [
      { category: "Architecture", text: "Renamed internal helpers: mobilePost → ebPost, mobileGet → ebGet. These were misleadingly named — they hit i.instagram.com but use EB web cookies, not the mobile session. The new names make any misuse immediately obvious. Architecture header updated with a method-name lookup table." },
    ],
  },
  {
    version: "1.0.250",
    date: "12 May 2026, 21:30",
    items: [
      { category: "Architecture", text: "Fixed: ALL Instagram API calls (viewStories, viewHighlights, viewReels, viewTimelineFeed seen, viewTimelineReels, visitNotifications, visitOwnProfile, visitSettingsAndActivity, saveMedia, likeDirectMessage, unsendDirectMessage, getFollowers, searchUserByUsername, getSuggestedUsers, getHashtagUsers, uploadPhoto, disableComments) now use the mobile session (igApiCookies) instead of EB web cookies. Zero actions now touch the EB session." },
    ],
  },
  {
    version: "1.0.249",
    date: "12 May 2026, 21:00",
    items: [
      { category: "View Stories", text: "Fixed: the 'seen' report now uses the mobile API session (igApiCookies) instead of the EB web session — the seen POST was previously sent with the wrong cookies, meaning Instagram may not have registered the story views." },
    ],
  },
  {
    version: "1.0.248",
    date: "12 May 2026, 20:40",
    items: [
      { category: "View Stories", text: "Fixed: reels_media fetch now uses POST (not GET) with a JSON user_ids body — Instagram returns HTTP 400 'Invalid reel id list' for GET requests. Stories are now correctly watched." },
    ],
  },
  {
    version: "1.0.247",
    date: "12 May 2026, 19:45",
    items: [
      { category: "View Stories", text: "Fixed: story items are now fetched via a separate API call (reels_media) since Instagram no longer includes them inline in the tray response — stories will now be correctly marked as watched." },
    ],
  },
  {
    version: "1.0.246",
    date: "12 May 2026, 19:15",
    items: [
      { category: "View Stories", text: "Added missing 'surface=2' parameter to the stories API call — Instagram silently returns an empty tray without it, even when followed accounts have active stories." },
      { category: "View Stories", text: "Now counts only story reels that actually contained items, with a new specific warning if the tray had entries but none had story data." },
    ],
  },
  {
    version: "1.0.245",
    date: "12 May 2026, 18:45",
    items: [
      { category: "View Stories", text: "Empty story tray now shows a distinct 'warn' activity entry instead of a silent '0 stories watched', making it clear whether the feed had no stories versus a session problem." },
    ],
  },
  {
    version: "1.0.244",
    date: "12 May 2026, 18:15",
    items: [
      { category: "View Stories", text: "Fixed 'Watched 0 stories' when an account imported from EQX already has valid API cookies — expired or rejected sessions now correctly show the 'no mobile session' warning instead of silently returning 0." },
    ],
  },
  {
    version: "1.0.243",
    date: "12 May 2026, 17:30",
    items: [
      { category: "What's New", text: "All changelog entries now show a time alongside the date (e.g. '12 May 2026, 17:30')." },
      { category: "Human Session Tools", text: "Repost settings now fully collapse and hide when the Repost checkbox is unticked, instead of remaining visible but dimmed." },
      { category: "EQX Import", text: "Each tool's settings and sources are now restored independently — a failure on one tool (e.g. Like) no longer blocks sources from being imported for other tools (e.g. Follow)." },
      { category: "Human Session Tools", text: "View Stories: added a clear 'no mobile session' activity-log warning when the account has not yet established a mobile API session — run Verify Credentials to fix." },
    ],
  },
  {
    version: "1.0.242",
    date: "12 May 2026, 16:30",
    items: [
      { category: "Embedded Browser", text: "Fill Credentials no longer turns red on a successful login — screenshot-timeout kills are now suppressed while the auto-login flow is running." },
      { category: "Human Session Tools", text: "View Stories now correctly fetches the timeline tray using the authenticated mobile session, fixing the '0 stories viewed' result." },
    ],
  },
  {
    version: "1.0.241",
    date: "12 May 2026, 14:00",
    items: [
      { category: "Embedded Browser", text: "Fixed EB freezing blank for up to 40 seconds on pages that are slow to load — it now recovers in ~12 seconds instead." },
    ],
  },
  {
    version: "1.0.240",
    date: "12 May 2026, 12:00",
    items: [
      { category: "Proxy Manager", text: "Page no longer scrolls — only the proxy list itself scrolls. The Split Accounts panel is now inside the main card." },
      { category: "Proxy Manager", text: "Ping and Delete buttons now sit immediately to the right of the Status column instead of being pushed to the far right." },
    ],
  },
  {
    version: "1.0.239",
    date: "12 May 2026, 10:30",
    items: [
      { category: "Accounts", text: "Bottom toolbar buttons (Select All, Select None, Actions, Columns) are now cyan to match the app logo." },
      { category: "Proxy Manager", text: "Bottom toolbar buttons (Auto-link, Ping All, Import, Export) are now cyan to match the app logo." },
    ],
  },
  {
    version: "1.0.238",
    date: "12 May 2026, 09:30",
    items: [
      { category: "Embedded Browser", text: "Added detailed server-side logging for browser freezes: every screenshot timeout, slow screenshot (>2s), and unexpected error now appears in the server log with timing and URL so the cause of freezes can be identified." },
    ],
  },
  {
    version: "1.0.237",
    date: "12 May 2026, 08:30",
    items: [
      { category: "Proxy Manager", text: "Assigned accounts are now always visible underneath each proxy — no more clicking to expand." },
    ],
  },
  {
    version: "1.0.236",
    date: "12 May 2026, 07:30",
    items: [
      { category: "Follow Tool", text: "When Instagram returns a block mid-session the tool stops immediately and waits for its next scheduled run — no more scraping new hashtags after a block." },
      { category: "Follow Tool", text: "Block messages in the activity log now show only the Instagram response (e.g. 'We're sorry, but something went wrong') — the internal HTTP request line is no longer included." },
      { category: "Embedded Browser", text: "The frozen-page overlay now waits 60 seconds before appearing (was 25s), preventing false alarms during slow post-login page loads." },
      { category: "Embedded Browser", text: "Added a 'Keep Waiting' button to the frozen-page overlay so you can dismiss it and let the page continue loading without wiping the session." },
      { category: "Accounts", text: "Switching accounts via the dropdown or arrow buttons now keeps you on the same tab — if you were on the Follow Tool you stay on the Follow Tool for the new account." },
      { category: "Proxy Manager", text: "Add Proxy button moved to sit directly right of the search field, styled sky-blue to match the Add Profile button." },
      { category: "Proxy Manager", text: "Split Evenly panel now has a Group dropdown (always visible) so you can restrict distribution to one account group only." },
      { category: "Proxy Manager", text: "Proxy list columns are now sortable — click Proxy, Username, Accounts, or Status to sort." },
      { category: "Profiles", text: "EQX import now accepts multiple files at once." },
      { category: "Profiles", text: "EQX export now includes the last 2000 API call history entries per account." },
      { category: "Dashboard", text: "Accounts stuck in 'verifying' on startup are automatically reset to inactive." },
      { category: "App", text: "Create Account sidebar icon changed from a chip to a wand." },
    ],
  },
  {
    version: "1.6.0",
    date: "8 May 2026, 17:58",
    items: [
      { category: "Embedded Browser", text: "Ctrl+C and Ctrl+X now copy selected text to the Windows clipboard works in both text inputs and regular page selections." },
      { category: "Embedded Browser", text: "Right-click Copy and Cut in the context menu also write the selected text to the Windows clipboard." },
      { category: "Proxy Manager", text: "Ping and Delete buttons moved to sit directly beside the profile count (5/5) badge on each proxy row." },
      { category: "Cookie Baker", text: "Activity log now persists to the database and survives app restarts and updates." },
      { category: "Cookie Baker", text: "When the Embedded Browser is already open for a profile, Cookie Baker reuses it (new background tab) instead of launching a second Chrome eliminates silent launch failures on Windows." },
      { category: "Cookie Baker", text: "All numeric settings (interval, sites, scroll times, internal links) compacted onto a single row for a cleaner layout." },
      { category: "Cookie Baker", text: "Removed the toggle button from the Activity view header navigate back via the '← Settings' link inside the activity panel." },
      { category: "App", text: "Added electron-builder icon config so Equinox.exe and taskbar/window toolbar now show the new cyan robot logo on Windows." },
    ],
  },
  {
    version: "1.5.0",
    date: "6 May 2026, 22:10",
    items: [
      { category: "Dashboard", text: "What's New tab icon changed from star to bell." },
      { category: "Dashboard", text: "Changelog is permanently stored in the app entries are never lost even if GitHub releases are deleted." },
      { category: "Dashboard", text: "Manage Columns now has ↑ ↓ step buttons (±10 px each click) alongside the pixel input." },
      { category: "Profiles", text: "Added Manage Columns button in the bottom bar next to Actions control column widths on the Accounts page, saved across sessions." },
      { category: "Settings", text: "Added visual separator lines between each settings section for easier navigation." },
      { category: "Verify", text: "Fixed account lockouts: accounts with an existing mobile session (igApiCookies) now use session validation only a fresh password login is never attempted on top of an active session." },
    ],
  },
  {
    version: "1.4.0",
    date: "6 May 2026, 18:05",
    items: [
      { category: "Dashboard", text: "Added Manage Columns button  set each Activity Log column width individually, saved across sessions." },
      { category: "Dashboard", text: "Server Started timestamp now always reflects the actual current process start time, not a cached daily value." },
      { category: "Profiles", text: "Actions window is 20% wider with a 2-column equal grid layout for all action buttons." },
      { category: "Profiles", text: "Verify popup now shows the exact number of selected profiles being verified, not the server total." },
      { category: "Follow Tool", text: "Toggle row now has a visible divider and spacing separating it from the settings below." },
      { category: "Follow Tool", text: "Target Sources and Followed Users moved onto the same row as the Switch and Copy Settings controls." },
      { category: "Profile Sync", text: "Stat icons (Followers, Following, Posts) sit on the left; Auto Sync controls stack on the right with a separator." },
      { category: "All Tools", text: "Copy Settings dialog widened to 840 px and taller (81 vh) for easier side-by-side comparison." },
      { category: "All Tools", text: "Copy Settings button text is now blue across all panels; Back to Accounts uses a red arrow." },
    ],
  },
  {
    version: "1.3.0",
    date: "5 May 2026, 11:54",
    items: [
      { category: "Engine", text: "Removed all web login fallback from automation engine  only the mobile Instagram API is ever used for automation." },
      { category: "Engine", text: "Startup scheduling: tools already enabled when the app starts now schedule their first run within the configured X–Y timer window instead of firing immediately." },
      { category: "Engine", text: "Toggle-on behaviour: enabling any tool from the dashboard now starts it immediately, without any scatter or delay." },
      { category: "Dashboard", text: "Timestamp columns in both the API Log and Session Log now show full date including year (e.g. 5 May 2026, 11:54:00)." },
      { category: "Dashboard", text: "Dashboard API Log and profile name list now auto-refresh every 5 seconds so live activity is always visible." },
      { category: "Dashboard", text: "Removed '(valid)' red annotation from the Live Activity Ticker  status is already communicated by the label." },
      { category: "Dashboard", text: "CSV export: Banyan 400 calls are now correctly treated as OK and excluded from the error count." },
    ],
  },
  {
    version: "1.2.0",
    date: "3 May 2026, 15:30",
    items: [
      { category: "Human Sessions", text: "Added local folder as a repost source  pick a folder on your PC's hard drive, images are automatically deleted after upload." },
      { category: "Human Sessions", text: "Added Save Media percentage  controls what share of liked timeline posts get saved to your Instagram collection." },
      { category: "Profiles", text: "Added bulk Verify All Accounts action with configurable staggered delays between each account." },
      { category: "Profiles", text: "Added keyboard shortcuts: Ctrl+D Delete, Ctrl+P Remove Proxies, Ctrl+R Verify All, Ctrl+F Fix Captcha." },
      { category: "Profiles", text: "Added Fix Captcha action  automatically resolves captcha challenges using 2captcha.com." },
      { category: "Unfollow Tool", text: "Added custom target user list  enter usernames manually, import from a .txt/.csv file, or fetch followings via HikerAPI." },
      { category: "Auto Reply", text: "Added option to only reply to users the account already follows." },
      { category: "Auto Reply", text: "Added option to like the incoming DM before sending the auto-reply." },
      { category: "All Tools", text: "All active tools now display estimated items/hour and next scheduled execution time." },
      { category: "Dashboard", text: "Added What's New tab showing feature and fix history for each release." },
      { category: "Settings", text: "Added 2Captcha API key configuration for the Fix Captcha feature." },
      { category: "Settings", text: "Added Verify All Accounts delay  configurable min/max seconds between each account verification." },
    ],
  },
  {
    version: "1.1.0",
    date: "14 April 2026, 10:00",
    items: [
      { category: "Repost", text: "Added image alteration pipeline with small / medium / high presets and manual per-filter overrides (contrast, brightness, noise, sharpen, pixelate)." },
      { category: "Repost", text: "Added HikerAPI feed scraping option so repost doesn't consume account session requests." },
      { category: "Repost", text: "Auto-disable repost when post count reaches a configurable target, or when all source posts have already been reposted." },
      { category: "Human Sessions", text: "Added Post Caption spintax support with placeholders: {original_caption}, {source_username}, {own_username}." },
      { category: "Unfollow Tool", text: "Added whitelist support  accounts on the whitelist are never unfollowed regardless of follow age." },
      { category: "Follow Tool", text: "Added source filtering by follower count, following count, and post count." },
      { category: "Contact Tool", text: "Added DM sending to new followers with configurable delay and message templates." },
      { category: "Proxy Manager", text: "Added proxy health-check with latency display and bulk import from CSV." },
    ],
  },
  {
    version: "1.0.0",
    date: "2 March 2026, 09:00",
    items: [
      { category: "Core", text: "Initial release of Equinox automation dashboard." },
      { category: "Core", text: "Multi-account management with status tracking, proxy assignment, and 2FA support." },
      { category: "Follow Tool", text: "Follow users from a source account's followers/followings list with configurable daily limits and delays." },
      { category: "Unfollow Tool", text: "Unfollow non-followers and ghost followers with configurable schedules." },
      { category: "Human Sessions", text: "Simulate natural browsing: visit notifications, like timeline posts, visit explore page." },
      { category: "Auto Reply", text: "Trigger-word based DM auto-reply with per-profile rule sets." },
      { category: "Dashboard", text: "Live API Call Log showing every Instagram request made by the engine in real time." },
    ],
  },
];

const CATEGORY_COLORS: Record<string, string> = {
  "Engine": "bg-emerald-100 text-emerald-700",
  "Human Sessions": "bg-purple-100 text-purple-700",
  "Profiles": "bg-blue-100 text-blue-700",
  "Unfollow Tool": "bg-orange-100 text-orange-700",
  "Auto Reply": "bg-green-100 text-green-700",
  "Dashboard": "bg-indigo-100 text-indigo-700",
  "Settings": "bg-slate-100 text-slate-700",
  "Follow Tool": "bg-sky-100 text-sky-700",
  "Contact Tool": "bg-teal-100 text-teal-700",
  "Proxy Manager": "bg-yellow-100 text-yellow-700",
  "Repost": "bg-pink-100 text-pink-700",
  "Core": "bg-gray-100 text-gray-700",
  "Fix": "bg-red-100 text-red-700",
};

type FeedItem = {
  key: string;
  ts: number;
  profileId: number;
  kind: "api" | "session" | "import";
  operationName?: string;
  message?: string;
  profileLabel?: string;
  action?: string;
  targetUsername?: string;
  detail?: string;
  importData?: LastImport;
};

type LastImport = { ts: number; fileName: string; created: number; updated: number; failed: number; total: number };

export function Dashboard() {
  const [lastImport, setLastImport] = useState<LastImport | null>(() => {
    try { return JSON.parse(localStorage.getItem("equinox_last_import") ?? "null"); } catch { return null; }
  });
  const [importDismissed, setImportDismissed] = useState<number>(() =>
    Number(localStorage.getItem("equinox_import_dismissed") ?? 0)
  );

  const [activeTab, setActiveTab] = useState<Tab>(() =>
    (sessionStorage.getItem("dashboard:tab") as Tab) ?? "api-log"
  );
  const [changelogFilter, setChangelogFilter] = useState("");
  const [apiLogSearch, setApiLogSearch] = useState(() =>
    sessionStorage.getItem("dashboard:search") ?? ""
  );
  const [selectedProfileId, setSelectedProfileId] = useState<number | null>(() => {
    const dashProfile = sessionStorage.getItem("dashboard:profileId");
    if (dashProfile) {
      sessionStorage.removeItem("dashboard:profileId");
      return Number(dashProfile);
    }
    const stored = sessionStorage.getItem("dashboard:selectedProfileId");
    return stored ? Number(stored) : null;
  });
  const [profilePickerOpen, setProfilePickerOpen] = useState(false);
  const [profileSearch, setProfileSearch] = useState("");
  const [manageColsOpen, setManageColsOpen] = useState(false);
  const [colWidths, setColWidths] = useState<typeof DEFAULT_COL_WIDTHS>(() => {
    try {
      const s = localStorage.getItem("dashboard_col_widths_px");
      return s ? { ...DEFAULT_COL_WIDTHS, ...JSON.parse(s) } : DEFAULT_COL_WIDTHS;
    } catch { return DEFAULT_COL_WIDTHS; }
  });
  const pickerRef = useRef<HTMLDivElement>(null);
  const manageColsRef = useRef<HTMLDivElement>(null);

  // ── Persist dashboard state across navigation ─────────────────────────────────
  useEffect(() => { sessionStorage.setItem("dashboard:tab", activeTab); }, [activeTab]);
  useEffect(() => { sessionStorage.setItem("dashboard:search", apiLogSearch); }, [apiLogSearch]);
  useEffect(() => {
    if (selectedProfileId !== null) sessionStorage.setItem("dashboard:selectedProfileId", String(selectedProfileId));
    else sessionStorage.removeItem("dashboard:selectedProfileId");
  }, [selectedProfileId]);

  // ── Unified feed: both API calls + session actions merged by timestamp ────────
  const [feedItems, setFeedItems] = useState<FeedItem[]>([]);
  const [clearedAt, setClearedAt] = useState<number>(() => {
    const stored = localStorage.getItem("dashboard_cleared_at");
    return stored ? Number(stored) : 0;
  });
  const [errorsCleared, setErrorsCleared] = useState<number>(() => {
    const stored = localStorage.getItem("dashboard_errors_cleared_at");
    return stored ? Number(stored) : 0;
  });
  const [initialLoading, setInitialLoading] = useState(true);
  const lastApiIdRef = useRef<number>(0);
  const lastSessionIdRef = useRef<number>(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchFeed = useCallback(async (isInitial = false) => {
    try {
      const [apiRes, sessionRes] = await Promise.all([
        fetch(lastApiIdRef.current > 0
          ? `/api/instagram-api-calls?since=${lastApiIdRef.current}`
          : "/api/instagram-api-calls"),
        fetch("/api/all-session-actions?limit=500"),
      ]);
      const [apiRows, sessionRows]: [any[], any[]] = await Promise.all([
        apiRes.ok ? apiRes.json() : Promise.resolve([]),
        sessionRes.ok ? sessionRes.json() : Promise.resolve([]),
      ]);

      // Operations already covered by a clean session_action entry no need to
      // show the raw API log row as well (it would just be ugly duplicate noise).
      const HIDDEN_OPS = new Set(["getNewFollowersHikerAPI", "getNewFollowers", "v1/user/by/username"]);

      const newApiRows: FeedItem[] = apiRows
        // "Account" source = timed() calls from InstagramWebClient already
        // surfaced as session_actions, so skip to avoid duplicate entries.
        // "Browser"/"Verify" = EB and login calls never useful in the feed.
        // "HikerAPI" = scrape metadata shown since it adds unique context.
        .filter((c: any) => c.source !== "Browser" && c.source !== "Verify" && c.source !== "Account")
        .filter((c: any) => !HIDDEN_OPS.has(c.operationName))
        .map((c: any) => ({
          key: `api-${c.id}`,
          ts: new Date(c.date).getTime(),
          profileId: Number(c.profileId),
          kind: "api",
          operationName: c.operationName,
          message: c.message,
          profileLabel: c.username,
        }));

      if (apiRows.length > 0) {
        const maxApiId = Math.max(...apiRows.map((r: any) => r.id));
        lastApiIdRef.current = Math.max(lastApiIdRef.current, maxApiId);
      }

      const newSessionRows = isInitial
        ? sessionRows
        : sessionRows.filter((r: any) => r.id > lastSessionIdRef.current);

      if (sessionRows.length > 0) {
        const maxSessId = Math.max(...sessionRows.map((r: any) => r.id));
        lastSessionIdRef.current = Math.max(lastSessionIdRef.current, maxSessId);
      }

      const newSessionItems: FeedItem[] = newSessionRows.map((a: any) => ({
        key: `sess-${a.id}`,
        ts: new Date(a.timestamp).getTime(),
        profileId: Number(a.profileId),
        kind: "session",
        action: a.action,
        targetUsername: a.targetUsername,
        detail: a.detail,
        profileLabel: a.profileLabel,
      }));

      if (isInitial) {
        const all = [...newApiRows, ...newSessionItems].sort((a, b) => b.ts - a.ts);
        setFeedItems(all);
      } else {
        const incoming = [...newApiRows, ...newSessionItems];
        if (incoming.length > 0) {
          setFeedItems(prev => [...incoming, ...prev].sort((a, b) => b.ts - a.ts));
        }
      }
    } catch { /* ignore */ } finally {
      if (isInitial) setInitialLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const schedule = () => {
      pollTimerRef.current = setTimeout(async () => {
        if (cancelled) return;
        await fetchFeed(false);
        if (!cancelled) schedule();
      }, 4000);
    };
    fetchFeed(true).then(() => { if (!cancelled) schedule(); });
    return () => {
      cancelled = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [fetchFeed]);

  // ── Server startup time ──────────────────────────────────────────────────────
  const { data: serverInfo } = useQuery<{ startedAt: string }>({
    queryKey: ["/api/server-info"],
  });

  const { data: profiles } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
    refetchInterval: 5000,
  });

  const getUsername = (profileId: number, _label?: string) => {
    const p = profiles?.find(p => Number(p.id) === Number(profileId));
    return p?.accountLabel || p?.username || _label || `#${profileId}`;
  };

  const selectedProfile = profiles?.find(p => p.id === selectedProfileId) ?? null;

  const filteredFeed = feedItems
    .filter((item) => clearedAt === 0 || item.ts > clearedAt)
    .filter((item) => {
      if (errorsCleared === 0 || item.ts > errorsCleared) return true;
      return !(item.kind === "session" && item.action && ERROR_ACTIONS.has(item.action));
    })
    .filter((item) => selectedProfileId == null || item.profileId === selectedProfileId)
    .filter((item) => {
      if (!apiLogSearch.trim()) return true;
      const q = apiLogSearch.toLowerCase();
      const label = getUsername(item.profileId, item.profileLabel).toLowerCase();
      if (item.kind === "api") {
        return (
          label.includes(q) ||
          (item.operationName ?? "").toLowerCase().includes(q) ||
          (item.message ?? "").toLowerCase().includes(q)
        );
      }
      return (
        label.includes(q) ||
        (item.action ?? "").toLowerCase().includes(q) ||
        (item.targetUsername ?? "").toLowerCase().includes(q) ||
        (item.detail ?? "").toLowerCase().includes(q)
      );
    });

  const filteredProfileOptions = (profiles ?? []).filter(p =>
    !profileSearch.trim() ||
    p.username.toLowerCase().includes(profileSearch.toLowerCase())
  );

  // Merge the CSV-import notification (stored in localStorage) into the sorted feed
  // so it appears at its correct timestamp instead of being pinned at the top.
  const displayFeed: FeedItem[] = (() => {
    if (!lastImport || lastImport.ts <= importDismissed) return filteredFeed;
    const importItem: FeedItem = {
      key: "import-notif",
      ts: lastImport.ts,
      profileId: 0,
      kind: "import",
      importData: lastImport,
    };
    return [...filteredFeed, importItem].sort((a, b) => b.ts - a.ts);
  })();

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setProfilePickerOpen(false);
        setProfileSearch("");
      }
      if (manageColsRef.current && !manageColsRef.current.contains(e.target as Node)) {
        setManageColsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const tabClass = (t: Tab) =>
    `px-4 py-2.5 text-sm font-semibold transition-colors border-b-2 -mb-px flex items-center gap-2 ${
      activeTab === t
        ? "border-primary text-primary"
        : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
    }`;

  const filteredChangelog = changelogFilter.trim()
    ? CHANGELOG.map(v => ({
        ...v,
        items: v.items.filter(
          i =>
            i.text.toLowerCase().includes(changelogFilter.toLowerCase()) ||
            i.category.toLowerCase().includes(changelogFilter.toLowerCase()),
        ),
      })).filter(v => v.items.length > 0)
    : CHANGELOG;

  return (
    <AppLayout>
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Dashboard</h1>
        <p className="text-muted-foreground text-sm">Live view of tasks</p>
        {serverInfo?.startedAt && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground/70 border border-border/40 rounded px-2 py-0.5 bg-muted/20">
            <RefreshCw className="w-3 h-3" />
            Server started {format(new Date(serverInfo.startedAt), "MMM d yyyy 'at' HH:mm:ss")}
          </span>
        )}
      </div>

      <Card className="desktop-card border-none shadow-sm">
        <div className="flex items-center border-b border-border/50 px-4">
          <button className={tabClass("api-log")} onClick={() => setActiveTab("api-log")}>
            <Zap className="w-4 h-4" /> Activity Log
          </button>
          <button className={tabClass("whats-new")} onClick={() => setActiveTab("whats-new")}>
            <Bell className="w-4 h-4" /> What's New
          </button>
          <div className="ml-auto flex items-center gap-1">
            {activeTab === "api-log" && (
              <div ref={manageColsRef} className="relative">
                <button
                  onClick={() => setManageColsOpen(o => !o)}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-2.5 px-2"
                >
                  <Settings2 className="w-3.5 h-3.5" /> Manage Columns
                </button>
                {manageColsOpen && (
                  <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-border rounded-lg shadow-xl p-4 w-60">
                    <p className="text-[11px] font-bold uppercase tracking-wide mb-3 text-muted-foreground">Column Widths (px)</p>
                    {([ ["account", "Account"], ["event", "Event"], ["target", "Target"], ["detail", "Detail"], ["timestamp", "Timestamp"] ] as [keyof typeof DEFAULT_COL_WIDTHS, string][]).map(([key, label]) => {
                      const updateCol = (delta: number) => {
                        const v = Math.max(40, Math.min(600, colWidths[key] + delta));
                        const next = { ...colWidths, [key]: v };
                        setColWidths(next);
                        localStorage.setItem("dashboard_col_widths_px", JSON.stringify(next));
                      };
                      return (
                        <div key={key} className="flex items-center gap-1.5 mb-2">
                          <label className="text-xs w-20 text-muted-foreground shrink-0">{label}</label>
                          <button
                            onClick={() => updateCol(-10)}
                            className="h-6 w-6 flex items-center justify-center border border-border rounded bg-background hover:bg-muted/40 text-muted-foreground transition-colors shrink-0"
                          >
                            <ChevronDown className="w-3 h-3" />
                          </button>
                          <input
                            type="number"
                            min={40}
                            max={600}
                            value={colWidths[key]}
                            onChange={e => {
                              const v = Math.max(40, Math.min(600, Number(e.target.value)));
                              const next = { ...colWidths, [key]: v };
                              setColWidths(next);
                              localStorage.setItem("dashboard_col_widths_px", JSON.stringify(next));
                            }}
                            className="h-6 w-14 text-xs border border-border rounded px-1.5 bg-background text-center"
                          />
                          <button
                            onClick={() => updateCol(10)}
                            className="h-6 w-6 flex items-center justify-center border border-border rounded bg-background hover:bg-muted/40 text-muted-foreground transition-colors shrink-0"
                          >
                            <ChevronUp className="w-3 h-3" />
                          </button>
                        </div>
                      );
                    })}
                    <button
                      onClick={() => { setColWidths(DEFAULT_COL_WIDTHS); localStorage.removeItem("dashboard_col_widths_px"); }}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors mt-1"
                    >
                      Reset to defaults
                    </button>
                  </div>
                )}
              </div>
            )}
            <button
              onClick={() => { const t = Date.now(); localStorage.setItem("dashboard_errors_cleared_at", String(t)); setErrorsCleared(t); }}
              className="text-xs text-muted-foreground hover:text-destructive transition-colors py-2.5 px-2"
            >
              Clear errors
            </button>
            <button
              onClick={() => { const t = Date.now(); localStorage.setItem("dashboard_cleared_at", String(t)); setClearedAt(t); }}
              className="text-xs text-muted-foreground hover:text-destructive transition-colors py-2.5 px-2"
            >
              Clear feed
            </button>
          </div>
        </div>


        <CardHeader className="border-b border-border/50 bg-muted/5 py-3 px-6">
          <div className={`flex items-center gap-3 flex-wrap ${activeTab !== "api-log" ? "hidden" : ""}`}>
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-border bg-background min-w-[200px] flex-1 max-w-xs">
              <Search className="w-3 h-3 text-muted-foreground shrink-0" />
              <input
                type="text"
                placeholder="Search operation, account, message..."
                value={apiLogSearch}
                onChange={e => setApiLogSearch(e.target.value)}
                className="text-xs bg-transparent outline-none flex-1 text-foreground placeholder:text-muted-foreground"
              />
              {apiLogSearch && (
                <button onClick={() => setApiLogSearch("")}>
                  <X className="w-3 h-3 text-muted-foreground hover:text-foreground" />
                </button>
              )}
            </div>
            <p className="text-xs text-muted-foreground flex-1 text-right hidden sm:block">
              {feedItems.length > 0
                ? `${filteredFeed.length.toLocaleString()} of ${feedItems.filter(i => selectedProfileId == null || i.profileId === selectedProfileId).length.toLocaleString()} entries`
                : "Waiting for activity…"}
            </p>
            <div ref={pickerRef} className="relative shrink-0">
              <button
                type="button"
                onClick={() => { setProfilePickerOpen(o => !o); setProfileSearch(""); }}
                className="h-7 pl-2.5 pr-2 text-xs rounded border border-border bg-background text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors flex items-center gap-1.5 min-w-[160px] max-w-[220px]"
              >
                <User className="w-3 h-3 shrink-0" />
                <span className="flex-1 truncate text-left">
                  {selectedProfile ? selectedProfile.username : "All accounts"}
                </span>
                {selectedProfile ? (
                  <X
                    className="w-3 h-3 shrink-0 hover:text-destructive"
                    onClick={(e) => { e.stopPropagation(); setSelectedProfileId(null); setProfilePickerOpen(false); }}
                  />
                ) : (
                  <ChevronDown className="w-3 h-3 shrink-0" />
                )}
              </button>
              {profilePickerOpen && (
                <div className="absolute right-0 top-full mt-1 w-56 bg-background border border-border rounded shadow-lg z-50">
                  <div className="p-2 border-b border-border">
                    <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-muted/40">
                      <Search className="w-3 h-3 text-muted-foreground shrink-0" />
                      <input
                        autoFocus
                        type="text"
                        placeholder="Filter accounts..."
                        value={profileSearch}
                        onChange={e => setProfileSearch(e.target.value)}
                        className="text-xs bg-transparent outline-none flex-1 text-foreground placeholder:text-muted-foreground"
                      />
                    </div>
                  </div>
                  <div className="max-h-48 overflow-y-auto py-1">
                    <button
                      type="button"
                      onClick={() => { setSelectedProfileId(null); setProfilePickerOpen(false); setProfileSearch(""); }}
                      className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-accent/50 transition-colors ${selectedProfileId === null ? "text-primary font-semibold" : "text-foreground"}`}
                    >
                      <Activity className="w-3 h-3 shrink-0" /> All accounts
                    </button>
                    {filteredProfileOptions.map(p => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => { setSelectedProfileId(p.id); setProfilePickerOpen(false); setProfileSearch(""); }}
                        className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-accent/50 transition-colors truncate ${selectedProfileId === p.id ? "text-primary font-semibold" : "text-foreground"}`}
                      >
                        <User className="w-3.5 h-3.5 shrink-0 text-primary" />
                        <span className="truncate">{p.username}</span>
                      </button>
                    ))}
                    {filteredProfileOptions.length === 0 && (
                      <p className="px-3 py-2 text-xs text-muted-foreground">No accounts match</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className={`flex items-center gap-2 ${activeTab !== "whats-new" ? "hidden" : ""}`}>
            <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              type="text"
              placeholder="Filter change log items..."
              value={changelogFilter}
              onChange={e => setChangelogFilter(e.target.value)}
              className="text-xs bg-transparent outline-none text-foreground placeholder:text-muted-foreground w-64"
            />
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {activeTab === "api-log" ? (
            <div className="overflow-y-auto overflow-x-hidden max-h-[70vh]">
              <table className="w-full text-sm text-left table-fixed">
                <colgroup>
                  <col style={{ width: `${colWidths.account}px` }} />
                  <col style={{ width: `${colWidths.event}px` }} />
                  <col style={{ width: `${colWidths.target}px` }} />
                  <col style={{ width: `${colWidths.detail}px` }} />
                  <col style={{ width: `${colWidths.timestamp}px` }} />
                </colgroup>
                <thead className="text-xs uppercase bg-muted/80 text-muted-foreground font-bold border-b border-border/50 sticky top-0 z-10 backdrop-blur-sm">
                  <tr>
                    <th className="px-3 py-4 font-bold">Account</th>
                    <th className="px-3 py-4 font-bold">Event</th>
                    <th className="px-3 py-4 font-bold">Target</th>
                    <th className="px-3 py-4 font-bold">Detail</th>
                    <th className="px-3 py-4 font-bold">Timestamp</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {initialLoading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <tr key={i} className="animate-pulse">
                        <td colSpan={5} className="px-3 py-4 bg-muted/10 h-12" />
                      </tr>
                    ))
                  ) : filteredFeed.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-12 text-center text-muted-foreground">
                        <Activity className="w-8 h-8 mx-auto mb-3 text-muted-foreground/30" />
                        <p className="text-sm font-medium">
                          {apiLogSearch.trim()
                            ? `No results for "${apiLogSearch}"`
                            : selectedProfileId != null
                            ? `No activity for @${selectedProfile?.username ?? selectedProfileId}`
                            : "No activity recorded yet"}
                        </p>
                        <p className="text-xs mt-1">
                          {apiLogSearch.trim()
                            ? "Try a different search term."
                            : selectedProfileId != null
                            ? "Try selecting a different account or clear the filter."
                            : "Start an automation tool to see activity here."}
                        </p>
                      </td>
                    </tr>
                  ) : (
                    displayFeed.map((item) => {
                      const label = getUsername(item.profileId, item.profileLabel);
                      if (item.kind === "import") {
                        const imp = item.importData!;
                        return (
                          <tr key={item.key} className="bg-blue-50/60 hover:bg-blue-50/80 transition-colors">
                            <td className="px-3 py-3 font-medium truncate">
                              <span className="flex items-center gap-1.5 text-foreground min-w-0">
                                <Upload className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                                <span className="truncate text-xs font-semibold">Import</span>
                              </span>
                            </td>
                            <td className="px-3 py-3 truncate">
                              <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-700 text-[10px] font-bold uppercase tracking-wider">
                                Profile Import
                              </span>
                            </td>
                            <td className="px-3 py-3 text-xs text-muted-foreground truncate" title={imp.fileName}>
                              {imp.fileName}
                            </td>
                            <td className="px-3 py-3 text-xs truncate">
                              <span className="flex items-center gap-2">
                                {imp.created > 0 && <span className="font-semibold text-emerald-600">{imp.created} created</span>}
                                {imp.updated > 0 && <span className="font-semibold text-blue-600">{imp.updated} updated</span>}
                                {imp.failed > 0 && <span className="font-semibold text-destructive">{imp.failed} failed</span>}
                              </span>
                            </td>
                            <td className="px-3 py-3 text-muted-foreground text-xs font-mono truncate">
                              <span className="flex items-center gap-1 min-w-0">
                                <Clock className="w-3 h-3 shrink-0" />
                                <span className="truncate">{format(new Date(imp.ts), "MMM d yyyy, HH:mm:ss")}</span>
                                <button
                                  onClick={() => { localStorage.setItem("equinox_import_dismissed", String(imp.ts)); setImportDismissed(imp.ts); }}
                                  className="ml-auto text-muted-foreground hover:text-foreground transition-colors shrink-0"
                                  title="Dismiss"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              </span>
                            </td>
                          </tr>
                        );
                      }
                      if (item.kind === "api") {
                        return (
                          <tr key={item.key} className="hover:bg-accent/5 transition-colors">
                            <td className="px-3 py-3 font-medium truncate">
                              <Link
                                href={`/profiles/${item.profileId}?tab=follow`}
                                className="flex items-center gap-1.5 text-foreground hover:text-primary transition-colors group min-w-0"
                              >
                                <User className="w-3.5 h-3.5 text-primary shrink-0" />
                                <span className="group-hover:underline underline-offset-2 truncate">{label}</span>
                              </Link>
                            </td>
                            <td className="px-3 py-3 truncate">
                              <span className="px-2 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-bold uppercase tracking-wider truncate inline-block max-w-full">
                                {(item.operationName ?? "").replace(/_/g, " ")}
                              </span>
                            </td>
                            <td className="px-3 py-3 text-xs text-muted-foreground truncate"> </td>
                            <td className="px-3 py-3 text-foreground truncate text-xs" title={item.message || undefined}>
                              {item.message || " "}
                            </td>
                            <td className="px-3 py-3 text-muted-foreground text-xs font-mono truncate">
                              <span className="flex items-center gap-1 min-w-0">
                                <Clock className="w-3 h-3 shrink-0" />
                                <span className="truncate">{format(new Date(item.ts), "MMM d yyyy, HH:mm:ss")}</span>
                              </span>
                            </td>
                          </tr>
                        );
                      }
                      const style = ACTION_STYLES[item.action ?? ""] ?? { label: (item.action ?? "event").replace(/_/g, " "), cls: "bg-muted text-muted-foreground", icon: "·" };
                      return (
                        <tr key={item.key} className="hover:bg-accent/5 transition-colors">
                          <td className="px-3 py-3 font-medium truncate">
                            <Link
                              href={`/profiles/${item.profileId}?tab=follow`}
                              className="flex items-center gap-1.5 text-foreground hover:text-primary transition-colors group min-w-0"
                            >
                              <User className="w-3.5 h-3.5 text-primary shrink-0" />
                              <span className="group-hover:underline underline-offset-2 truncate">{label}</span>
                            </Link>
                          </td>
                          <td className="px-3 py-3 truncate">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider truncate inline-flex items-center gap-1 max-w-full ${style.cls}`}>
                              <span>{style.label}</span>
                              <span className="shrink-0 leading-none">{style.icon}</span>
                            </span>
                          </td>
                          <td className="px-3 py-3 text-xs text-foreground/80 truncate" title={item.targetUsername || undefined}>
                            {item.targetUsername ? `@${item.targetUsername}` : " "}
                          </td>
                          <td className="px-3 py-3 text-foreground truncate text-xs" title={item.detail || undefined}>
                            {item.detail || " "}
                          </td>
                          <td className="px-3 py-3 text-muted-foreground text-xs font-mono truncate">
                            <span className="flex items-center gap-1 min-w-0">
                              <Clock className="w-3 h-3 shrink-0" />
                              <span className="truncate">{format(new Date(item.ts), "MMM d yyyy, HH:mm:ss")}</span>
                            </span>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="max-h-[70vh] overflow-y-auto px-6 py-4 space-y-8">
              {filteredChangelog.length === 0 ? (
                <div className="py-12 text-center text-muted-foreground">
                  <Sparkles className="w-8 h-8 mx-auto mb-3 text-muted-foreground/30" />
                  <p className="text-sm font-medium">No matching items</p>
                </div>
              ) : (
                filteredChangelog.map((ver) => (
                  <div key={ver.version}>
                    <div className="flex items-baseline gap-3 mb-3">
                      <span className="text-base font-bold text-foreground">Version {ver.version}</span>
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="w-3 h-3 shrink-0" />
                        {ver.date}
                      </span>
                    </div>
                    <ul className="space-y-2">
                      {ver.items.map((item, i) => (
                        <li key={i} className="flex items-start gap-2.5 text-sm">
                          <span className="mt-0.5 shrink-0">
                            <span className={`inline-block text-[10px] font-bold px-1.5 py-0.5 rounded ${CATEGORY_COLORS[item.category] ?? "bg-muted text-muted-foreground"}`}>
                              {item.category}
                            </span>
                          </span>
                          <span className="text-foreground leading-relaxed">{item.text}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </AppLayout>
  );
}
