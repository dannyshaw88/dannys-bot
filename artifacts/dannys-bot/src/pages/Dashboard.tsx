import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { usePersistentSetting } from "@/hooks/use-persistent-setting";
import { useScrollRestore } from "@/hooks/useScrollRestore";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Activity, Clock, User, Zap, Sparkles, Bell, Search, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, X, RefreshCw, Settings2, Upload, Download,
  Fingerprint, ThumbsUp, Monitor,
} from "lucide-react";
import { useBrowserWindows } from "@/contexts/BrowserWindowsContext";
import { TrustScoreBadge, getTrustScore, getTrustLevels } from "@/components/TrustScoreBadge";
import { format } from "date-fns";
import { type Profile } from "@shared/schema";

type Tab = "api-log" | "whats-new";

const ERROR_ACTIONS = new Set([
  "verification_failed", "follow_blocked", "unfollow_blocked",
  "dm_blocked", "contact_dm_blocked", "logged_out",
]);

const ACTION_STYLES: Record<string, { label: string; cls: string; icon: string | React.ReactNode }> = {
  human_session_start:     { label: "Started",         cls: "text-blue-600",      icon: <ThumbsUp size={11} /> },
  tool_start:              { label: "Started",         cls: "text-blue-700",      icon: <ThumbsUp size={11} /> },
  tool_complete:           { label: "Complete",        cls: "text-emerald-700",   icon: "✓" },
  verified:                { label: "Verified",        cls: "text-green-700",     icon: "✓" },
  verification_failed:     { label: "Verify Fail",     cls: "text-red-700",       icon: "✗" },
  follow:                  { label: "Follow",          cls: "text-sky-700",       icon: "+" },
  follow_blocked:          { label: "Blocked",         cls: "text-rose-700",      icon: "⊘" },
  follow_abandoned:        { label: "Abandoned",       cls: "text-amber-600",     icon: "↩" },
  follow_skipped:          { label: "Skipped",         cls: "text-orange-700",    icon: "⇥" },
  dedup_skip:              { label: "Skipped",         cls: "text-amber-700",     icon: "⇥" },
  filter_skip:             { label: "Filter Skip",     cls: "text-yellow-800",    icon: "⊘" },
  unfollow:                { label: "Unfollow",        cls: "text-violet-700",    icon: "−" },
  unfollow_blocked:        { label: "UF Block",        cls: "text-pink-700",      icon: "⊘" },
  dm:                      { label: "DM",              cls: "text-purple-700",    icon: "✉" },
  dm_blocked:              { label: "DM Block",        cls: "text-fuchsia-700",   icon: "⊘" },
  contact_dm_blocked:      { label: "Contact Block",   cls: "text-indigo-700",    icon: "⊘" },
  abd_dismissed:           { label: "ABD Cleared",     cls: "text-teal-700",      icon: "✓" },
  no_sources:              { label: "No Sources",      cls: "text-slate-600",     icon: "⚠" },
  logged_out:              { label: "Logged Out",      cls: "text-red-700",       icon: "⚠" },
  account_imported:        { label: "EQX Import",      cls: "text-blue-700",      icon: "↓" },
  account_exported:        { label: "EQX Export",      cls: "text-cyan-700",      icon: "↑" },
  view_timeline_feed:      { label: "Timeline Feed",   cls: "text-teal-700",      icon: "≡" },
  feed_timeline_load:      { label: "Feed Load",       cls: "text-teal-700",      icon: "≡" },
  feed_timeline_seen:      { label: "Feed Seen",       cls: "text-teal-600",      icon: "✓" },
  like_timeline_post:      { label: "Timeline Like",   cls: "text-rose-600",      icon: "♥" },
  check_timeline_reels:    { label: "Watch Reels",     cls: "text-orange-700",    icon: "▶" },
  check_timeline_stories:  { label: "Watch Stories",   cls: "text-amber-700",     icon: "◎" },
  visit_notifications:     { label: "Notifications",   cls: "text-sky-600",       icon: "🔔" },
  visit_own_profile:       { label: "Own Profile",     cls: "text-indigo-600",    icon: "◉" },
  refresh_own_profile:     { label: "Refresh Profile", cls: "text-indigo-600",    icon: "↺" },
  visit_settings_activity: { label: "Settings",        cls: "text-slate-600",     icon: "⚙" },
  save_media:              { label: "Save Media",      cls: "text-emerald-600",   icon: "⊙" },
  server_started:          { label: "Started",         cls: "text-cyan-600",      icon: "⚡" },
  repost:                  { label: "Repost",          cls: "text-pink-600",      icon: "↻" },
  check_dm:                { label: "Check DM",        cls: "text-purple-600",    icon: "✉" },
  view_post:               { label: "View Post",       cls: "text-teal-600",      icon: "◈" },
  visit_profile:           { label: "Visit Profile",   cls: "text-sky-700",       icon: "◉" },
  view_profile_post:       { label: "View Profile Post", cls: "text-cyan-700",    icon: "◈" },
  view_profile_feed:       { label: "View Profile Feed", cls: "text-cyan-600",    icon: "≡" },
};

const DEFAULT_COL_WIDTHS = { account: 160, open_eb: 80, event: 150, target: 100, detail: 200, timestamp: 220, trustscore: 120 };
const DEFAULT_COL_ORDER: (keyof typeof DEFAULT_COL_WIDTHS)[] = ["account", "open_eb", "trustscore", "event", "target", "detail", "timestamp"];
const COL_LABELS: Record<keyof typeof DEFAULT_COL_WIDTHS, string> = {
  account: "ACCOUNT", open_eb: "OPEN EB", event: "ACTION", target: "TARGET", detail: "DETAIL", timestamp: "TIMESTAMP", trustscore: "TRUSTSCORE",
};

const CHANGELOG: { version: string; date: string; items: { category: string; text: string }[] }[] = [
  {
    version: "1.1.219",
    date: "28 Jun 2026",
    items: [
      { category: "UI", text: "Inject Browsing: settings now open in a centred dialog (click Open) instead of a hover popup — no more accidental dismissals." },
      { category: "Feature", text: "Inject Browsing: added Order % min/max field inside the dialog so injection order is randomised each session instead of always being the same." },
      { category: "UI", text: "Inject Search and Inject Browsing % input fields are slightly wider for easier clicking." },
      { category: "Copy Settings", text: "Inject Browsing Order % is now included when copying injection settings to other profiles." },
    ],
  },
  {
    version: "1.1.218",
    date: "28 Jun 2026",
    items: [
      { category: "UI", text: "Ghost Browser signup tab: Fingerprint is now its own card on the same row as Proxy and Device Identity." },
      { category: "UI", text: "Ghost Browser: removed the inner scroll bar from the signup panel — the page now scrolls naturally." },
      { category: "UI", text: "Ghost Browser: Device Identity dropdown now matches the full width of the Proxy dropdown." },
      { category: "UI", text: "Ghost Browser: scheduler min/max input fields are slightly narrower." },
      { category: "UI", text: "Ghost Browser: Username, Password, DOB, Bio, and all email/IMAP fields are more compact." },
      { category: "UI", text: "Ghost Browser: action buttons reduced in width and Nuke Environment moved before Add to Equinox." },
    ],
  },
  {
    version: "1.1.217",
    date: "28 Jun 2026",
    items: [
      { category: "Fix", text: "Export API Calls: ViewTimelineFeedSeen rows no longer appear as 'ERROR: Marked X posts as seen' in the CSV. Instagram's seen endpoint sometimes returns a non-200 response but the session stays valid — this is now treated as non-fatal so the rows are stored correctly." },
    ],
  },
  {
    version: "1.1.216",
    date: "28 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser: when you click 'Add to Equinox', it now sends the exact username that was used during the actual signup — not a freshly re-rolled random version of the spintax template. Previously every click re-resolved the template, often producing a different username than the one Instagram registered." },
      { category: "Fix", text: "Ghost Browser: the account name in Account Manager now defaults to the username — previously it was blank when added via 'Add to Equinox'." },
      { category: "Fix", text: "Ghost Browser: session cookies captured at signup are now properly written to the account's browser profile on 'Add to Equinox'. When you open the embedded browser for that account from Account Manager, it will already be logged in." },
      { category: "Fix", text: "Ghost Browser: the right-hand 'Browser not started' placeholder panel has been removed. The tool now fills the full screen width as a single panel." },
    ],
  },
  {
    version: "1.1.215",
    date: "28 Jun 2026",
    items: [
      { category: "Fix", text: "API call log now correctly shows 'ViewTimelineFeedSeen' (with a success or error result) instead of 'MediaSeen ERROR' when the software marks timeline posts as seen. The previous build stripped the named-wrapper logging so the raw URL-derived name leaked through. Fixed." },
      { category: "Fix", text: "When loading timeline posts, MediaSeen errors no longer appear. The outer operation name (ViewTimelineFeedSeen) is now the single entry — it shows ERROR if Instagram rejects the call, and shows success with the count if it works." },
      { category: "Fix", text: "Dashboard now shows live entries during timeline feed loading — a Feed Load entry fires per page fetched and a Feed Seen entry fires per batch marked seen, so you can watch the tool working in real time instead of seeing nothing until it finishes." },
    ],
  },
  {
    version: "1.1.214",
    date: "28 Jun 2026",
    items: [
      { category: "Fix", text: "API call log no longer shows 'Media{mediaId}Like' as the operation name for likes — it now correctly shows 'LikeMedia'. Instagram reel/post IDs like '3926681724376877436_25025320' contain an underscore which was bypassing the ID-stripping logic. Fixed." },
      { category: "Fix", text: "Removed the dead /clips/clips_viewed/ endpoint call. Instagram's server returns a 404 HTML page for this endpoint — it no longer exists. It was generating a 'ClipsClipsViewed ERROR: Request failed' log entry every session. The media/seen call already covers the reel view signal so nothing is lost." },
      { category: "Fix", text: "API call operation names are now cleaner. 'ClipsClipsViewed' (redundant 'Clips' prefix) is gone. Any operation name where the first segment is a prefix of the second is now automatically collapsed." },
    ],
  },
  {
    version: "1.1.213",
    date: "28 Jun 2026",
    items: [
      { category: "Fix", text: "Mark feed as seen no longer shows ERROR in the API call log. Instagram's seen endpoint returns an empty response on success — the software was incorrectly treating an empty body as a failure and marking the session as needing re-verification. Fixed: only real 4xx/5xx responses are treated as errors now." },
      { category: "Improve", text: "Dashboard activity log now shows each feed page load and each mark-seen batch as individual entries instead of one bundled 'Viewed X posts' line. If the tool loads 4 pages and marks 50 posts as seen, you see 4 Feed Load entries and 13 Feed Seen entries, so you can see exactly what the software is doing in real time." },
    ],
  },
  {
    version: "1.1.212",
    date: "28 Jun 2026",
    items: [
      { category: "Fix", text: "Follow tool now correctly stops the session when Instagram returns a 404 on a follow request — this is Instagram's way of signalling a hard follow block, and is now treated the same as the standard block response." },
      { category: "Fix", text: "API call log export now records every real HTTP call sent to Instagram as exactly one row. Previously some calls (follows, likes, DMs via the API library) were missing from the export, and others appeared twice. Every call is now captured once at the network layer with no duplicates and no fake entries." },
      { category: "Fix", text: "API call log messages are now human-readable for every endpoint. Like errors say 'Like failed', explore visits say 'Explore feed loaded (N posts)', stories tray says 'N stories in tray', DM inbox says 'Inbox overview: N threads'. Previously these showed raw URL paths like /api/v1/media/.../like/." },
    ],
  },
  {
    version: "1.1.208",
    date: "28 Jun 2026",
    items: [
      { category: "Fix", text: "API call log now shows the full time each call took — including the throttle wait — so you can confirm your API Controls settings are being respected. Previously it only showed the raw server response time, making it look like calls were firing far faster than configured." },
    ],
  },
  {
    version: "1.1.210",
    date: "28 Jun 2026",
    items: [
      { category: "Fix", text: "Fixed 2 unthrottled Instagram API calls firing at the start of every single tool run. The CSRF token was being erased on every tool execution (because session setup runs before every tool), which forced a 2-call bootstrap sequence before every action. That bootstrap had no throttle delay, so those 2 calls always appeared in the log at 0ms apart and were not respecting your API Controls. Now the CSRF token is kept in memory between runs — bootstrap only fires once per session, not before every tool." },
      { category: "Fix", text: "Removed fake entries from the API call log. ViewFeedPost and VisitUserProfile made no HTTP call to Instagram but were still being logged as if they did — removed. ViewFeedReel was logging twice (once as ViewFeedReel, once as ClipsViewed) for the same single HTTP call — now logs once as ClipsViewed only." },
    ],
  },
  {
    version: "1.1.207",
    date: "27 Jun 2026",
    items: [
      { category: "Fix", text: "Pinging a Local Adapter proxy while it is mid-rotation now correctly shows Dead instead of a false Alive result." },
      { category: "Fix", text: "Navigating away from the Proxy Manager page no longer loses the rotating spinner — state is now server-driven so it survives page changes." },
      { category: "Improve", text: "The PROXY MANAGER sidebar icon shows a small spinning indicator whenever any adapter is rotating, so you can see it from any page without toast popups." },
    ],
  },
  {
    version: "1.1.206",
    date: "27 Jun 2026",
    items: [
      { category: "Fix", text: "Local Adapter tunnel now auto-starts when an account needs it — previously a dongle re-plugged after app launch would leave the tunnel port stale and all assigned accounts would show no internet connection." },
      { category: "Fix", text: "Automation tools using Local Adapter accounts now always read the live tunnel port instead of a potentially stale port from the database." },
      { category: "Fix", text: "Local Adapter tunnel now forces IPv4 DNS resolution before connecting, avoiding IPv6 address selection and producing clearer error messages when the target hostname fails to resolve." },
    ],
  },
  {
    version: "1.1.205",
    date: "27 Jun 2026",
    items: [
      { category: "Improve", text: "Timeline feed now marks posts as seen page-by-page as it scrolls, matching real Instagram behaviour — previously it loaded all pages first and sent all seen marks in a batch at the end." },
    ],
  },
  {
    version: "1.1.204",
    date: "27 Jun 2026",
    items: [
      { category: "Fix", text: "ShareStoryViaDM now shows as its own labelled action in the activity log — previously it was appearing as DirectV2Inbox because the story-share inbox lookup (finding a thread to send to) was leaking through as a raw transport call." },
    ],
  },
  {
    version: "1.1.203",
    date: "27 Jun 2026",
    items: [
      { category: "Fix", text: "Like results now show 'Like successful', 'Like failed', or 'Like blocked by Instagram' — the raw HTTP error string no longer appears in the activity log." },
      { category: "Fix", text: "DirectV2Inbox is now correctly labelled as GetDirectMessages in the activity log — it was an auto-generated name for the same inbox endpoint." },
    ],
  },
  {
    version: "1.1.202",
    date: "27 Jun 2026",
    items: [
      { category: "Improve", text: "Rotate Now button (circular arrow) added to adapter rows — click to immediately disconnect and reconnect the dongle to get a new IP. Spins orange for 35 seconds while the cycle completes." },
      { category: "Fix", text: "Rotate Every column now visible by default — adapter rows show the min–max minute inputs, other rows show a dash." },
      { category: "Fix", text: "Non-sortable column headers (Rotate Every, etc.) now show a grab cursor so it's clear they can be dragged to reorder." },
    ],
  },
  {
    version: "1.1.201",
    date: "27 Jun 2026",
    items: [
      { category: "Fix", text: "Proxy status column now shows latency after pinging a local adapter — previously always showed the IP address even after a ping." },
      { category: "Improve", text: "Rotate Every column is now visible by default for all proxies — adapter rows show min–max minute inputs, regular proxy rows show a dash." },
      { category: "Improve", text: "Adapter IP rotation is now fully automatic: the app uses netsh to disable the adapter for 30 seconds then re-enables it, forcing the carrier to assign a new IP." },
      { category: "Improve", text: "Manual rotate button now actually disconnects and reconnects the adapter instead of just showing a note telling you to unplug it." },
      { category: "Improve", text: "Ghost Browser: Fingerprint section moved directly under the proxy dropdown in the same card for easier access." },
    ],
  },
  {
    version: "1.1.200",
    date: "27 Jun 2026",
    items: [
      { category: "Fix", text: "Adapter proxy row: reverted custom name field — the Windows adapter name (e.g. 'Ethernet 3') now shows directly in the dropdown as before." },
      { category: "Improve", text: "Ghost Browser proxy dropdown: adapter proxies now appear in the list with a USB icon and show their Windows adapter name (e.g. 'Ethernet 3') and tunnel address." },
      { category: "Improve", text: "Ghost Browser: selecting an adapter proxy correctly routes the browser through the 4G tunnel (127.0.0.1:port) instead of the placeholder 0.0.0.0:8080 address." },
    ],
  },
  {
    version: "1.1.199",
    date: "27 Jun 2026",
    items: [
      { category: "Improve", text: "Adapter proxy row now has a custom name field — type '4G-UFI-489' (or anything you like) and it saves permanently." },
      { category: "Improve", text: "Hardware adapter dropdown ('Ethernet 3') is now compact and sits below the custom name label." },
      { category: "Improve", text: "Picking an adapter from the dropdown now auto-starts the tunnel immediately — no separate button needed." },
      { category: "Improve", text: "Ping button now measures real round-trip latency through the 4G tunnel (instead of just checking if the adapter is present)." },
      { category: "Fix", text: "Removed the Stop Tunnel and USB check buttons — the tunnel is automatic and the Ping WiFi button is the only action needed." },
    ],
  },
  {
    version: "1.1.198",
    date: "27 Jun 2026",
    items: [
      { category: "Fix", text: "Adapter proxy tunnel button now correctly shows as active (red Stop) instead of Play after a page refresh — the app remembers the tunnel is already running." },
      { category: "Fix", text: "On app startup, adapter proxy tunnels auto-start immediately — you only need to click Start Tunnel once when first setting up a new adapter row." },
    ],
  },
  {
    version: "1.1.197",
    date: "27 Jun 2026",
    items: [
      { category: "Fix", text: "Proxy Manager — selecting an adapter from the dropdown no longer resets the row type back to HTTP. Saving any single field on an adapter proxy now correctly leaves all other fields (type, adapter name, rotate schedule) untouched." },
    ],
  },
  {
    version: "1.1.196",
    date: "27 Jun 2026",
    items: [
      { category: "Debug", text: "App now logs all detected network adapters to the console when the Proxy Manager adapter list is opened — helps diagnose why a dongle or wireless adapter may not appear in the dropdown." },
    ],
  },
  {
    version: "1.1.195",
    date: "27 Jun 2026",
    items: [
      { category: "Fix", text: "Proxy Manager adapter dropdown now shows all network adapters including 4G dongles that Windows registers as wireless adapters — previously only adapters with an active IP were listed." },
    ],
  },
  {
    version: "1.1.194",
    date: "27 Jun 2026",
    items: [
      { category: "Fix", text: "Contact tool no longer fires when its master switch is off — sub-toggles could previously bypass the master switch and trigger unintended API calls." },
      { category: "Fix", text: "API call log now shows one entry per action instead of two. Duplicate confirmation entries (Like Post Successful, Follow via IgApiClient, Marked reel as played) have been removed — only the real throttled Instagram endpoint hit is recorded." },
    ],
  },
  {
    version: "1.1.193",
    date: "27 Jun 2026",
    items: [
      { category: "New", text: "Proxy Manager — Local Adapter proxy type added. Click 'Add Local Adapter', select your 4G dongle from the adapter dropdown, and the app builds an internal proxy tunnel bound to that adapter — no third-party software needed. All other HTTP/SOCKS5 proxies are completely unaffected." },
      { category: "New", text: "Rotate Every column — adapter proxies show a min/max minute range. The app will trigger an IP rotation on that schedule. Leave blank for no auto-rotate." },
      { category: "New", text: "Adapter status column shows the current 4G IP address instead of ping latency. Shows 'Unplugged' if the dongle is removed." },
    ],
  },
  {
    version: "1.1.192",
    date: "27 Jun 2026",
    items: [
      { category: "Update", text: "Evasion Stats — The Recipe tab renamed to The Rules. Updated with 4 confirmed/tested survival rules: 125s–250s minimum between all API calls, 150–250 min between sessions, instant ban for heavy endpoints or budget overruns, and 400 API calls required before the first follow. Sub-details removed for clarity." },
    ],
  },
  {
    version: "1.1.191",
    date: "27 Jun 2026",
    items: [
      { category: "New", text: "View Timeline Feed now has a Share % option — set a min/max percentage chance and the engine will click the two-arrow share button on that portion of posts scrolled during each session, sharing them to your followers in the feed." },
      { category: "Audit", text: "Full audit of Human Session tool confirmed: every action (notifications, own profile, timeline feed, stories, DMs, likes, saves, shares) goes through the Instagram mobile API only. Zero embedded browser calls." },
    ],
  },
  {
    version: "1.1.190",
    date: "27 Jun 2026",
    items: [
      { category: "New", text: "Check Stories from Timeline now has a Like % option — set a min/max percentage and the engine will like that portion of the story slides it watched each session." },
      { category: "New", text: "Check Stories from Timeline now has a Share % option — set a min/max percentage and the engine will share that portion of slides via DM to a random existing conversation, exactly as the in-app share button does." },
    ],
  },
  {
    version: "1.1.189",
    date: "27 Jun 2026",
    items: [
      { category: "Fix", text: "Total Calls column on the Accounts page no longer counts HikerAPI calls — it now only reflects direct Instagram API calls made by your account, matching the intent of the column." },
      { category: "Fix", text: "Throttle architecture hardened: all Instagram library (ig.*) automation calls now go through a single factory (_newAutomationIgClient) that hooks the throttle at the transport level. Photo repost/upload was previously bypassing API Controls entirely — now covered. Follow and Like no longer double-throttle." },
    ],
  },
  {
    version: "1.1.188",
    date: "27 Jun 2026",
    items: [
      { category: "Fix", text: "Complete throttle audit — three additional bypass paths closed: (1) loginApiThrottle() in Verify Credentials had the same independent-random-extremes bug as v1.1.186; with 1 min / 1 max / 125–250s the verify sequence could still fire faster than 125s between calls. Fixed to use the same range formula as apiThrottle(). (2) browserSendDM() — the browser-session DM path (page.evaluate fetch) was sending directly to Instagram with no throttle at all. (3) uploadPhotoViaFetch() — same: browser-session photo upload bypassed throttle entirely. Both browser-path functions now apply the account's API Controls setting before firing." },
    ],
  },
  {
    version: "1.1.187",
    date: "27 Jun 2026",
    items: [
      { category: "Fix", text: "API Controls throttle: CSRF bootstrap calls (_bootstrapMobileCsrf) were firing before apiThrottle() in mobileSessionGet, mobileSessionPost, and mobilePostMultipart. On the first call after a session restore, this sent 1–2 unthrottled HTTP requests to Instagram before the throttle delay ran, completely bypassing your API Controls setting. apiThrottle() now always fires first — the CSRF bootstrap only runs after the configured delay has elapsed." },
    ],
  },
  {
    version: "1.1.186",
    date: "27 Jun 2026",
    items: [
      { category: "Fix", text: "API Controls throttle: the delay formula was randomising request count and time window independently, which could combine the worst extremes (most requests, shortest window) and produce delays far shorter than your setting. The fix computes the fastest and slowest valid delay from your configured range and picks a random point between them — so the actual delay always stays within the bounds you set." },
    ],
  },
  {
    version: "1.1.185",
    date: "27 Jun 2026",
    items: [
      { category: "Fix", text: "Verify bootstrap: FetchConfig (qe/sync) was being called twice per verify — once as the ABD probe and again as a separate Phase 2b step. The ABD probe is the FetchConfig call; the redundant second call has been removed. Each verify now sends qe/sync exactly once." },
    ],
  },
  {
    version: "1.1.184",
    date: "26 Jun 2026",
    items: [
      { category: "New", text: "Accounts page: added a Human Session column with the same on/off toggle as the Active column. Toggling it enables or disables the Human Session tool for that account without needing to open the account and navigate to the tool." },
      { category: "Fix", text: "Tools → Trust Scores: note text fields are now left-aligned instead of right-aligned." },
    ],
  },
  {
    version: "1.1.183",
    date: "26 Jun 2026",
    items: [
      { category: "Fix", text: "View Timeline Feed pagination: removed the hardcoded 0.8–1.5s delay between pages that was added in v1.1.182. Each page call goes through the existing API throttle (controlled by API Controls in Account Settings) — no extra sleep needed." },
    ],
  },
  {
    version: "1.1.182",
    date: "26 Jun 2026",
    items: [
      { category: "Fix", text: "View Timeline Feed now paginates properly. Instagram returns only ~12–18 posts per API call, so setting 50–100 posts was always stopping at the first page. The tool now fetches additional pages using the next_max_id cursor until the target count is reached (up to 8 pages)." },
    ],
  },
  {
    version: "1.1.181",
    date: "26 Jun 2026",
    items: [
      { category: "Fix", text: "Check Direct Messages: removed the NotificationsBadge (news/inbox warm-up) call that was firing before every DM check and causing it to fail. DM check now goes straight to GetDirectMessages then opens each thread — no warm-up call." },
      { category: "Fix", text: "Like Timeline Posts: the 'mark reels seen' call inside the Like tool was logging as 'ERROR: Marking media as seen' in API Calls when Instagram returned a non-200. The call is now wrapped in a proper timed block so it appears as a named entry and errors are handled silently." },
      { category: "Fix", text: "Like via IgApiClient log message changed to 'like-successfull'." },
      { category: "Fix", text: "No-proxy verify error message changed from 'Please assign a proxy before verifying.' to 'Failed, Please assign a proxy'." },
    ],
  },
  {
    version: "1.1.180",
    date: "26 Jun 2026",
    items: [
      { category: "Fix", text: "HikerAPI cache miss (Extract Now / DM Tool / Follow Tool): when HikerAPI has no cached data for an account's followers, the tool now skips cleanly with a log message instead of crashing with a 400 error. No account fallback — the session is simply skipped and retried next time." },
      { category: "Improvement", text: "Ban Analytics — Theories tab: every detection theory now has a Disprove button. Dismissed theories dim, strike through, get a 'Disproved [date]' badge, hide their bar and evidence, and sink to the bottom of the list. A Restore button brings them back. State is saved per error tab and survives restarts." },
      { category: "Fix", text: "Ban Analytics — endpoint diversity display: the broken 'X% diverse' figure (which collapsed toward 0% for long-running accounts) has been replaced. Unique endpoints now shows 'X of N calls' and Shannon entropy is labelled as the actual diversity metric. The cross-stats Diversity ratio row is marked as misleading for long sessions." },
    ],
  },
  {
    version: "1.1.179",
    date: "26 Jun 2026",
    items: [
      { category: "Fix", text: "Contact Tool DMs: fixed the actual code bug causing 4415001 — when the warm-up failed, the code was incorrectly falling through to a second DM path (_mobileDmPost) that also has no warm-up, guaranteeing another 4415001. Now it stops immediately and retries next session instead of burning a failed attempt." },
    ],
  },
  {
    version: "1.1.178",
    date: "26 Jun 2026",
    items: [
      { category: "Fix", text: "Make-a-Post / Repost: fixed the 'upload id is missing' configure error — the rur shard-routing cookie is now read instantly from the browser cookie file (which always has it) instead of relying on a slow 3-minute API call that often times out without returning one. This means rupload and configure now land on the same Instagram backend server." },
    ],
  },
  {
    version: "1.1.177",
    date: "26 Jun 2026",
    items: [
      { category: "Fix", text: "Contact Tool DMs: fixed the real root cause of the 4415001 error — the warm-up call was silently failing due to a proxy/network drop (connection reset), but the code was still caching the broken state and sending the DM anyway. Now falls back to a second warm-up call (currentUser) and only retries the DM if at least one warm-up succeeds." },
      { category: "Fix", text: "Contact Tool DMs: when 4415001 fires, the warm-up cache is now invalidated so the next session retries the full warm-up sequence instead of re-using the broken cached state." },
      { category: "Fix", text: "Make-a-Post / Repost: when the upload is rejected with session expired, the account is now automatically marked for re-verify — so it re-establishes its session without you needing to manually intervene." },
    ],
  },
  {
    version: "1.1.176",
    date: "26 Jun 2026",
    items: [
      { category: "Fix", text: "Make-a-Post / Repost: when the upload is rejected with 'session expired / login required', the activity log now says 'Re-verify account to resume reposting' instead of the generic 'will retry' — so you know exactly what action to take." },
      { category: "Fix", text: "Contact Tool / Send-a-Message: DMs that fail with error 4415001 'Prompt has contribution' are now correctly treated as blocked (same as ActionBlocked) — stops the tool from retrying an account-level Instagram restriction indefinitely." },
      { category: "Improvement", text: "Make-a-Post debugging log added to the code — tracks all known upload failure causes and fixes so future issues are faster to diagnose." },
    ],
  },
  {
    version: "1.1.175",
    date: "26 Jun 2026",
    items: [
      { category: "Fix", text: "Make-a-Post / Repost: when the image upload is rejected by Instagram (session expired), the error message now correctly says 'session expired or auth failure' — previously it was showing an unrelated error from an earlier step." },
      { category: "Fix", text: "Contact Tool: the Equinox User DM feature no longer picks TrustScore skeleton accounts as recipients — only real accounts are included in the pool." },
      { category: "Fix", text: "Account Manager: TrustScore skeleton accounts are now completely hidden from the accounts list — they only appear in the TrustScore section where they belong." },
    ],
  },
  {
    version: "1.1.174",
    date: "26 Jun 2026",
    items: [
      { category: "Fix", text: "Contact Tool: DMs no longer fail with 'Prompt has contribution' — the DM now uses the already-warmed session (news inbox already fetched) instead of a cold fresh client, matching exactly how Jarvee warms the session before sending." },
      { category: "Fix", text: "Make-a-Post / Repost: fixed 'upload id is missing' error — a shard-routing cookie (rur) is now seeded with a cheap API call before the image upload begins, so both the upload and the publish step land on the same Instagram backend server every time." },
    ],
  },
  {
    version: "1.1.173",
    date: "26 Jun 2026",
    items: [
      { category: "Feature", text: "Contact Tool → Message an Equinox User: new 'Don't message the same account twice' checkbox — when enabled, previously-messaged Equinox accounts (pending and sent) are skipped and a fresh one is picked each session." },
      { category: "Fix", text: "Verify Credentials: FetchConfig (qe/sync) is now called only once during verify bootstrap and never during the DM warm-up — the duplicate qe/sync call has been removed entirely from the session bootstrap." },
    ],
  },
  {
    version: "1.1.171",
    date: "26 Jun 2026",
    items: [
      { category: "Feature", text: "Contact Tool → Contact Users Sending: new 'Message an Equinox User' option — each session, a DM is automatically queued to a randomly picked account in the software. Includes a full SpinTax message template." },
      { category: "Improvement", text: "Contact Tool → Contact Users Sending: 'Pick a random message' and 'Unsend message after a delay' are now on the same row with Unsend After (min) inline." },
      { category: "Improvement", text: "Contact Tool → Contact Users Sending: removed standalone 'Wait Between Batches' setting — timing is controlled by the Human Session's Execute Every interval instead." },
    ],
  },
  {
    version: "1.1.170",
    date: "26 Jun 2026",
    items: [
      { category: "Feature", text: "Settings → Scraping / HikerAPI: new Human Session section with 'Profile Feed Scroll' toggle — when enabled, all profile feed fetches (Visit Author's Profile, Inject Profile Browsing) go through HikerAPI instead of the account's own session." },
    ],
  },
  {
    version: "1.1.169",
    date: "26 Jun 2026",
    items: [
      { category: "Fix", text: "Removed media.info scraping call from ViewFeedPost — the action is still logged but no longer hits an endpoint HikerAPI uses for scraping." },
      { category: "Fix", text: "Removed media.info scraping call from ViewFeedReel — only clips_viewed (the meaningful watch signal) is now sent." },
      { category: "Fix", text: "Removed users.info scraping call from VisitUserProfile — profile visit is logged without hitting the scraping endpoint." },
    ],
  },
  {
    version: "1.1.168",
    date: "26 Jun 2026",
    items: [
      { category: "Fix", text: "Like tool: removed the MediaInfo API call that was fired before every like action. Same unnecessary pre-warm pattern as UserInfo — it's a scraping endpoint and serves no purpose before a like POST." },
    ],
  },
  {
    version: "1.1.167",
    date: "26 Jun 2026",
    items: [
      { category: "Fix", text: "Follow tool: removed the UserInfo API call that was fired before every follow action. It served no purpose and is a high-signal scraping endpoint that Instagram watches closely. Challenge detection now works directly from the follow response itself." },
      { category: "Fix", text: "Removed UserInfo calls from cold-start warm-up and publish pre-warm as well — UserInfo is no longer called anywhere in the automation engine." },
    ],
  },
  {
    version: "1.1.166",
    date: "26 Jun 2026",
    items: [
      { category: "Fix", text: "Profile detail page: tool settings and fields no longer go grey or disappear mid-session when the embedded browser is active or account statuses are updating. The page now keeps showing existing data during background refreshes instead of briefly replacing everything with a loading state." },
    ],
  },
  {
    version: "1.1.165",
    date: "25 Jun 2026",
    items: [
      { category: "Fix", text: "Make a Post / Repost: rupload and configure now share the same proxy tunnel (HttpsProxyAgent) so Instagram routes both requests to the same backend shard. Previously they used separate connections which caused configure to return 'upload id is missing' even though the rupload succeeded. Also fixed a bug where the rur shard-routing cookie was never updated from the rupload response if one was already present in the session." },
    ],
  },
  {
    version: "1.1.164",
    date: "25 Jun 2026",
    items: [
      { category: "Fix", text: "Make a Post / Repost: photo and video uploads now send the raw binary buffer via Node.js HTTPS instead of CycleTLS. CycleTLS re-encodes the binary body through JSON, corrupting bytes above 127 — this caused the non-retryable ProcessingFailedError on every upload attempt. The shard-routing problem that originally motivated the CycleTLS switch is handled by the rur cookie already injected from the browser session, so both the upload and publish steps still land on the same Instagram backend server." },
    ],
  },
  {
    version: "1.1.163",
    date: "25 Jun 2026",
    items: [
      { category: "Fix", text: "Make a Post / Repost: removed the sRGB ICC profile embedded by the re-encoder — Instagram's rupload transcoder rejects JPEGs with embedded ICC profiles, which was causing the non-retryable ProcessingFailedError after the previous fix." },
      { category: "Fix", text: "Make a Post / Repost: changed JPEG encode quality from 92 to 80 and added 4:2:0 chroma subsampling to match the image_compression header sent in the rupload request, aligning our output with what the real Instagram Android client produces." },
    ],
  },
  {
    version: "1.1.162",
    date: "25 Jun 2026",
    items: [
      { category: "Fix", text: "Make a Post / Repost: images with a valid aspect ratio were being sent to Instagram without re-encoding — now all images are sanitised to baseline sRGB JPEG before upload, fixing a transcode failure that caused posts to silently fail." },
      { category: "Fix", text: "Device fingerprint: Chrome's cookie jar is now asserted against the database-stored mid and ig_did every time the embedded browser opens — prevents stale or wrong device IDs (from a previous Chrome session or a re-added account) from overwriting the authoritative device identity and triggering Instagram's 'unrecognised device' check." },
    ],
  },
  {
    version: "1.1.161",
    date: "25 Jun 2026",
    items: [
      { category: "Fix", text: "FetchConfig cold-start: fixed a bug where the warmed mobile client cache was being thrown away every time Instagram rotated the session cookie, causing FetchConfig to re-fire on every automation cycle after the first DM check — it now only fires once per verify." },
      { category: "Fix", text: "After Verify Credentials completes, the automation engine now explicitly resets the warm client so the new session gets a proper cold-start on its next DM check — this prevents the double-FetchConfig that was happening in the first session after a verify." },
    ],
  },
  {
    version: "1.1.160",
    date: "25 Jun 2026",
    items: [
      { category: "Fix", text: "Make a Post: switched the upload and configure steps to use CycleTLS (Android TLS fingerprint) instead of Node.js HTTPS — both steps now use the same TLS stack so Instagram routes them to the same backend shard." },
      { category: "Fix", text: "Human Session — Follow Tool: removed the Est. Rate display from below Skip Chance, as it is already visible next to the Followed Users button." },
      { category: "Feature", text: "Make a Post: added a README-REPLIT log panel directly below the 'Delete from PC after upload' checkbox — a scrollable dated record of every fix attempt so future sessions always know what has and hasn't been tried." },
    ],
  },
  {
    version: "1.1.159",
    date: "25 Jun 2026",
    items: [
      { category: "Fix", text: "API Calls export and pie chart: every Instagram endpoint hit is now logged — cold-start warm-up calls (UserInfo, NotificationsBadge, FetchConfig), CSRF bootstrap calls (FetchHeaders, GetCurrentUser), follow pre-warm (UserInfo + FollowUser), like pre-warm (MediaInfo + LikePost), and repost pre-warm + publish (UserInfo + PublishPhoto) all appear as individual rows in the export." },
    ],
  },
  {
    version: "1.1.158",
    date: "25 Jun 2026",
    items: [
      { category: "Feature", text: "Human Session — View Timeline Feed: the 'If 0 Posts' fallback now visits the Instagram Explore page instead of following suggested users. When the timeline returns 0 posts the account browses the Explore feed and can scroll posts, click into them, like at a set percentage, visit author profiles, scroll their feed, and click their posts — all configurable with Min/Max fields." },
      { category: "Feature", text: "Human Session — 'If 0 Posts → Visit Explore Page' settings block moved to its own row directly below the View Profile's Feed section, with six new setting rows: Posts to Scroll on Explore, Posts to Click On, % to Like, % to Visit Author's Profile, Posts to Scroll on Profile, and Posts to Click on Profile." },
    ],
  },
  {
    version: "1.1.157",
    date: "25 Jun 2026",
    items: [
      { category: "Feature", text: "Evasion Stats — Theories tab: 'The Recipe' card is now pinned at the top of every error tab. It shows the two current survivor findings: slow API calls (99–250s, confirmed) and the 3-day warmup protocol (session interval 90–250min, feed/stories/DMs at low-probability sub-actions, being tested)." },
      { category: "Fix", text: "Proxy manager assign dropdown: account names are now visible — the option text was appearing white-on-white in some system themes. Inline colour is now forced so the text always shows correctly." },
    ],
  },
  {
    version: "1.1.156",
    date: "25 Jun 2026",
    items: [
      { category: "Fix", text: "TrustScore badge at the top of each TrustScore tier now shows the correct custom colour and icon you set on the TrustScores page — it was previously always showing the default cyan." },
      { category: "Fix", text: "Account switcher dropdown inside a TrustScore tier now only shows other TrustScore tiers, not regular accounts from the Accounts Manager." },
      { category: "Fix", text: "Copy Settings inside a TrustScore tier now only lists other TrustScore tiers as copy targets — regular accounts no longer appear." },
      { category: "Fix", text: "Human Session tool inside a TrustScore tier: Copy Settings dialog now correctly shows only other TrustScore tiers." },
    ],
  },
  {
    version: "1.1.152",
    date: "24 Jun 2026",
    items: [
      { category: "Improve", text: "Locked account analysis now explains the real cause in plain English: the app is reconnecting to Instagram too many times per day (averaging 70 short connections vs 17 for surviving accounts). Each time the Human Sessions tool runs, it counts as a new session window — too many of these short repeated connections is the pattern Instagram flags. The anomaly score now weights this session-cycle count more heavily." },
      { category: "Improve", text: "Anomaly score now scales with burst-window count at four levels (0 / 5 / 20 / 50 cycles) instead of a flat score, so accounts with 70+ reconnection cycles rank significantly higher than those with a handful." },
      { category: "Improve", text: "Added 'Avg session cycles' stat to the Risk Indicators panel — shows the average number of reconnection windows per account across all flagged entries." },
    ],
  },
  {
    version: "1.1.151",
    date: "24 Jun 2026",
    items: [
      { category: "Fix", text: "Fixed the API call log timestamps — entries now always show when the call actually completed (when Instagram was contacted), not when the surrounding operation started. Previously, some entries showed a timestamp from before the inter-action delay, making the log look like rapid consecutive calls even when your rate settings were being respected." },
      { category: "Fix", text: "Fixed profile web lookups (web_profile_info) not going through the throttle. Every Instagram endpoint — including the web-session profile fetch used internally — now respects the rate limit set in your account's API Limits & Control settings." },
    ],
  },
  {
    version: "1.1.150",
    date: "24 Jun 2026",
    items: [
      { category: "Fix", text: "Fixed ViewTimelineFeedSeen to match Instagram's real mobile app behaviour. The real app sends at most 4 posts per seen call — previously the app was bundling all posts into one call regardless of count. Now if 5 posts are viewed, the log correctly shows two separate calls (4 + 1) exactly as a real phone would." },
    ],
  },
  {
    version: "1.1.149",
    date: "24 Jun 2026",
    items: [
      { category: "Fix", text: "Fixed the hard crash that kept happening when multiple browser windows opened at startup. The previous fix (running setup steps one at a time) was not enough — the underlying Chromium command that sets the mobile screen size was itself crashing the process. That command has now been removed entirely: instead, each browser window is created at the correct mobile screen size from the start, so no crash-prone override is needed." },
    ],
  },
  {
    version: "1.1.148",
    date: "24 Jun 2026",
    items: [
      { category: "Fix", text: "Fixed crash when opening multiple browser windows at once. Simultaneous browser setup was hitting a Chromium bug that causes a hard crash on Windows — the setup steps now run one at a time instead of all at once." },
      { category: "Fix", text: "All accounts are now visible again. A database flag was incorrectly set on every account, causing the accounts page to show nothing. This is now corrected automatically on startup." },
    ],
  },
  {
    version: "1.1.147",
    date: "24 Jun 2026",
    items: [
      { category: "Improvement", text: "Alive For column now shows a clean format like '10d 8h' or '8h 32m' instead of '0010:08:32'. The fixed-width monospace font has also been removed to match the rest of the table." },
    ],
  },
  {
    version: "1.1.146",
    date: "24 Jun 2026",
    items: [
      { category: "Fix", text: "Alive For column is no longer blank after updating. Existing accounts that were already Valid had no start date recorded (the column was new), so they now get their 'Added' date as the Alive For starting point instead of showing a dash." },
    ],
  },
  {
    version: "1.1.145",
    date: "24 Jun 2026",
    items: [
      { category: "Fix", text: "Fixed a crash that caused all accounts to disappear. A new database column (valid_since) was added to the schema but its setup step was missing, causing every account-related API call to fail with a database error on startup." },
    ],
  },
  {
    version: "1.1.144",
    date: "24 Jun 2026",
    items: [
      { category: "Debug", text: "Added detailed diagnostic logging to the accounts list — the API server now logs row counts and field values, and the frontend logs what it receives and how filtering works. This helps trace why accounts may not appear." },
    ],
  },
  {
    version: "1.1.143",
    date: "24 Jun 2026",
    items: [
      { category: "Fix", text: "Tools icon in the sidebar now matches the correct cyan colour used everywhere else in the app." },
      { category: "Fix", text: "Copy Settings in TrustScore tool tabs now only lists other TrustScore tier accounts — regular accounts from the accounts manager no longer appear." },
      { category: "Fix", text: "TrustScore badge at the top of an account now syncs immediately when a score is assigned anywhere in the app, without needing a page refresh." },
    ],
  },
  {
    version: "1.1.142",
    date: "24 Jun 2026",
    items: [
      { category: "Fix", text: "Copy Settings dialog: each account status now has its own unique colour — Pending is grey, Verifying is blue, Valid is green, Logged Out is yellow, Locked/Bad Password/Action Blocked are red, Banned is rose, Captcha/2FA/Email/Phone challenges are amber, and Stopped is zinc." },
      { category: "Fix", text: "Fixed a startup crash introduced in v1.1.141 that caused all pages to appear blank." },
    ],
  },
  {
    version: "1.1.140",
    date: "24 Jun 2026",
    items: [
      { category: "Fix", text: "Embedded browsers no longer show a blank white screen when the assigned proxy times out or refuses the connection. A clear error card now appears explaining the failure and prompting you to check the proxy, then press Reload." },
      { category: "Fix", text: "Alive For column now counts only from the first time an account was verified as Valid — not from when it was added to the software. Accounts that have never been verified show a dash." },
      { category: "Improvement", text: "Alive For timer format changed to DDDD:HH:MM (e.g. 0014:08:32 = 14 days, 8 hours, 32 minutes)." },
    ],
  },
  {
    version: "1.1.139",
    date: "24 Jun 2026",
    items: [
      { category: "Fix", text: "Embedded browser windows no longer open blank. A missing required field in Chrome's device-metrics command was causing it to fail immediately, which put the browser session into a bad state and made the two commands after it each hang for 3 seconds. The window was sitting blank for 7-8 seconds before the page started loading — it now loads as expected." },
      { category: "Fix", text: "Added a direct User-Agent setter as a fallback so the correct mobile UA reaches Instagram's servers even if the CDP path is slow or degraded. Instagram serves a genuinely blank HTML page when it sees a desktop UA, so this ensures that can never happen." },
    ],
  },
  {
    version: "1.1.138",
    date: "23 Jun 2026",
    items: [
      { category: "Fix", text: "Proxy Manager: Ping All no longer shows stale 'dead' badges from a previous run. All results are cleared before each new ping run so the summary only reflects the current test." },
      { category: "Fix", text: "Proxy Manager: Ping All now runs proxies in batches of 5 instead of all at once. Firing 20+ simultaneous TCP connections was starving the OS socket pool and causing healthy proxies to time out and appear dead." },
      { category: "Fix", text: "Proxy Manager: clicking Add Proxy now shows all fields blank instead of pre-filling 0.0.0.0:8080." },
    ],
  },
  {
    version: "1.1.137",
    date: "23 Jun 2026",
    items: [
      { category: "Feature", text: "If Equinox is restarted while an account is mid-verify (during the API bootstrap calls), it now automatically completes the verify on the next startup — no need to press Verify again. Only applies when the embedded browser login had already finished before the restart (cookies were already saved). Accounts restarted before that point are reset to Pending as before." },
    ],
  },
  {
    version: "1.1.136",
    date: "23 Jun 2026",
    items: [
      { category: "Fix", text: "Copying settings from the Human Session tool to other accounts now correctly applies to accounts that have not yet been verified (pending/error status). Previously the settings were saved but the display did not refresh, making it look like nothing had copied." },
      { category: "Fix", text: "If any part of a settings copy fails, the dialog now shows a clear error message instead of silently claiming success." },
    ],
  },
  {
    version: "1.1.135",
    date: "23 Jun 2026",
    items: [
      { category: "Feature", text: "New 'Alive For' column on the accounts page shows how long each account has been in the software. Timer starts when the account is first added and only resets if the account is deleted and re-imported. Sortable by clicking the header." },
      { category: "Fix", text: "Evasion stats export now includes all API calls made after an account was flagged (automated, captcha, locked, or banned) — not just the frozen snapshot taken at flag time. Accounts that resume after a flag now show their full call history in the export." },
      { category: "UI", text: "All account table columns (Followers, Following, Sync, ABD, Active) now centre-align their data to match the rest of the table." },
    ],
  },
  {
    version: "1.1.134",
    date: "23 Jun 2026",
    items: [
      { category: "Fix", text: "Last Call column on the accounts page now sorts correctly by actual last API call time (was incorrectly sorting by sync date). Clicking the header toggles oldest-first / newest-first." },
      { category: "Fix", text: "Removed the unnecessary down-arrow icon from the Last Call column header." },
    ],
  },
  {
    version: "1.1.133",
    date: "23 Jun 2026",
    items: [
      { category: "Fix", text: "When inject profile browsing is enabled, the 'already followed by another profile' check now runs immediately before the browse — not just at the top of the loop. Prevents browsing (and following) a user that another account picked up during the inject suggested/search window." },
    ],
  },
  {
    version: "1.1.132",
    date: "23 Jun 2026",
    items: [
      { category: "Fix", text: "Timeline browsing now marks all viewed posts as seen in a single API call (1 throttle) instead of one call per post. Same fix for user feed browsing and reel seen marks before likes." },
    ],
  },
  {
    version: "1.1.131",
    date: "23 Jun 2026",
    items: [
      { category: "Reverted", text: "Restored full API Control throttle on all calls including media/seen and clips_viewed — every call goes through the configured delay without exception." },
    ],
  },
  {
    version: "1.1.130",
    date: "23 Jun 2026",
    items: [
      { category: "Fix", text: "API Control throttle no longer stalls between each 'mark seen' call during timeline browsing. Marking 4 posts as seen now takes ~4–12 seconds total instead of 4 × 100–175s. The actual action slots (checkTimelineStories, checkDm, followTool) now fire on schedule." },
    ],
  },
  {
    version: "1.1.129",
    date: "23 Jun 2026",
    items: [
      { category: "Improved", text: "Tools icon in the sidebar now fills with cyan." },
      { category: "Improved", text: "Last Call and Total Calls column data is now centred under its header." },
      { category: "Renamed", text: "Column header 'Last API Call' is now 'Last Call'." },
      { category: "New", text: "Clicking the Last Call column header sorts accounts newest-to-oldest, then oldest-to-newest on a second click, with an arrow indicator showing the active sort direction." },
    ],
  },
  {
    version: "1.1.128",
    date: "23 Jun 2026",
    items: [
      { category: "Fix", text: "Follow Tool — Target Sources tab layout replaced with two separate collapsible sections (Hashtags and Followers of Account). Entries from one source type no longer mix into the other." },
      { category: "New", text: "Each source section now has its own Clear button — clears only that source type (hashtags or followers), not everything at once." },
      { category: "Improved", text: "Source sections collapse when unticked. Each list shows a maximum of 10 rows at a time and scrolls beyond that. Input fields are compact. Import and Export buttons moved into the Hashtags section header." },
    ],
  },
  {
    version: "1.1.127",
    date: "23 Jun 2026",
    items: [
      { category: "Fix", text: "Inject Browsing — Browse X Y % now works correctly. Previously the setting was ignored unless 'Browse Before Follow' was also ticked; now it fires on the configured percentage of follow slots whenever Inject Browsing is enabled." },
      { category: "Fix", text: "Removed the dead 'Browse Before Follow %' fields from the Inject Browsing popup — those values were never read by the engine. The Abandon Follow option is now always visible when browsing is enabled." },
    ],
  },
  {
    version: "1.1.126",
    date: "23 Jun 2026",
    items: [
      { category: "Fix", text: "Copy Human Session Settings → Target Sources now replaces the destination account's sources instead of adding on top of existing ones — targets are wiped first, then the source account's list is written in full." },
      { category: "Fix", text: "Followers of Account sources in the Follow Tool sources list were showing with a # prefix (looking like hashtags) — they now correctly display with an @ prefix." },
    ],
  },
  {
    version: "1.1.125",
    date: "23 Jun 2026",
    items: [
      { category: "New", text: "Settings → Scraping now has per-tool HikerAPI endpoint controls: each scraping endpoint (Hashtag Search, Get Followers, Get By Username, Get New Media Info, etc.) can be individually enabled or disabled for each tool." },
      { category: "New", text: "Follow Tool: separate checkboxes for Hashtag Search, Get Followers, and Get By Username endpoints." },
      { category: "New", text: "Unfollow, Contact, DM, Repost, and Profile Sync tools each have their own HikerAPI endpoint checkboxes — unticking one routes just that call through the account session instead." },
      { category: "New", text: "Other section adds global Get By Username / User ID toggle and a Sync API toggle for profile stats lookups." },
    ],
  },
  {
    version: "1.1.124",
    date: "23 Jun 2026",
    items: [
      { category: "Fix", text: "Follow Tool no longer runs inside a Human Session when it is set to STOPPED — the engine now re-checks the enabled state at the moment the follow slot executes, so toggling the checkbox off is guaranteed to take effect even if a session was already in progress." },
      { category: "Fix", text: "Same execution-time enabled re-check applied to the Unfollow Tool and Contact Tool when running inside the Human Session, preventing them from firing after being disabled mid-session." },
    ],
  },
  {
    version: "1.1.123",
    date: "23 Jun 2026",
    items: [
      { category: "Fix", text: "Get Suggested Users no longer fails with \"Method GET not allowed\" — Instagram's discover endpoint now requires POST and the app has been updated to match." },
      { category: "New", text: "Protect Accounts setting added to Settings → Automation: when enabled, all other accounts on the same proxy are automatically paused for a random window of time when one account is marked as banned." },
      { category: "New", text: "Protect Accounts pause window is configurable — set your own minimum and maximum minutes so the cooldown period is randomised within your chosen range." },
    ],
  },
  {
    version: "1.1.122",
    date: "23 Jun 2026",
    items: [
      { category: "Fix", text: "Total API Calls column header is now clickable — click once to sort smallest to largest, click again for largest to smallest." },
      { category: "Fix", text: "Randomise Timing in Copy Settings no longer makes accounts execute instantly — it now just schedules each account's next session at a different time without restarting anything." },
      { category: "Improve", text: "TrustScore notes in Tools: only the badge handle triggers drag — the notes text field no longer accidentally starts dragging when you try to type." },
      { category: "Improve", text: "TrustScore notes are now all the same width with right-aligned text so they line up neatly regardless of badge label length." },
      { category: "Improve", text: "Tools sidebar icon changed to a hammer for a cleaner look." },
      { category: "Fix", text: "Proxy Manager bin icon now shows the correct trash can with vertical lines." },
      { category: "Improve", text: "Keep Accounts Valid checkbox moved to sit directly under the Split Now button for easier access." },
      { category: "Fix", text: "Keep Accounts Valid now actually works — when unchecked and you reassign a proxy, the account drops to Pending so it gets re-verified. When checked, the account stays Valid." },
    ],
  },
  {
    version: "1.1.121",
    date: "23 Jun 2026",
    items: [
      { category: "Fix", text: "Columns dialog on Account Manager now opens perfectly centred on screen — no longer appears at the bottom." },
      { category: "Fix", text: "Total Calls column on Account Manager now correctly counts individual Instagram API calls, matching exactly what you see under Total API Calls in Statistics." },
      { category: "Fix", text: "API call activity log now shows the start time of each call instead of the end time, so ViewFeedReel and ClipsViewed correctly appear as separate sequential entries rather than the same timestamp." },
    ],
  },
  {
    version: "1.1.120",
    date: "22 Jun 2026",
    items: [
      { category: "New", text: "Account Manager: new Total Calls column showing the lifetime API call count for each account — the same figure as Lifetime API Calls in Statistics." },
      { category: "Improve", text: "Columns dialog on Account Manager, Statistics, Proxy Manager, and Dashboard now opens as a centred square dialog (like Actions) instead of a corner dropdown." },
      { category: "Improve", text: "Columns dialog now uses a 2-column grid layout for a cleaner, more compact view." },
      { category: "Fix", text: "Column labels in the Columns dialog now use normal capitalisation instead of all-caps." },
    ],
  },
  {
      version: "1.1.119",
      date: "22 Jun 2026",
      items: [
        { category: "Fix", text: "Account flag icon is now a solid filled flag — no longer appears as an outline." },
        { category: "Fix", text: "Flag icons now appear in the Copy Settings and Human Session account lists so you can see which accounts are flagged at a glance." },
        { category: "Fix", text: "GetSuggestedUsers: the activity log now shows the actual error message from Instagram instead of a blank entry, making it much easier to diagnose why the call is failing." },
      ],
    },
  {
    version: "1.1.118",
    date: "22 Jun 2026",
    items: [
      { category: "Improve", text: "Trust Scores tab redesigned as a vertical list. Each trust score now has a note field on the right that persists across sessions. Click any badge to open its template account settings directly." },
      { category: "Improve", text: "Trust Scores tab is now positioned before Import in the Tools page tab bar." },
      { category: "Improve", text: "Opening a trust score's template account now shows a breadcrumb at the top of the account page — click it to return to Trust Scores." },
      { category: "Fix", text: "GetSuggestedUsers: fixed the API call never appearing in the activity log when the endpoint returned an error. The call was silently swallowed — it now always logs, whether it succeeded or failed." },
      { category: "Fix", text: "GetSuggestedUsers: added detailed debug logging for injection failures so the exact error from Instagram is visible in the debug log." },
    ],
  },
  {
    version: "1.1.117",
    date: "22 Jun 2026",
    items: [
      { category: "Improvement", text: "Statistics page — Account Health & System block now appears above Action Totals." },
      { category: "Improvement", text: "Account Settings — Notes field width increased by 35% for more writing room." },
      { category: "Improvement", text: "Proxy Manager — assigned account icon is now the cyan filled person icon, matching the Accounts nav style." },
      { category: "Fix", text: "Proxy Manager — column headers and data cells now align correctly (removed justify-center that caused header/row offset when the Columns button was present)." },
      { category: "Improvement", text: "Trust Scores — each trust score now shows on its own row with an inline notes field to the right of the badge." },
      { category: "Fix", text: "Statistics page — flagged accounts now show the red flag icon next to their name, matching the Accounts page." },
    ],
  },
  {
    version: "1.1.116",
    date: "22 Jun 2026",
    items: [
      { category: "Fix", text: "Ban Analytics — Survivors tab: removed all passive/active/session category labels from the endpoint frequency map and per-account cards. The previous version was colouring and labelling endpoints as passive or active — those are assumptions about what Instagram scores, not facts. The map now shows raw endpoint names, what percentage of survivors called each one, and how many times per session, with no interpretation applied." },
    ],
  },
  {
    version: "1.1.115",
    date: "22 Jun 2026",
    items: [
      { category: "Improvement", text: "Ban Analytics — Survivors tab now shows a session recipe panel with the actual numbers from surviving accounts: what percentage of their calls were passive, how many passive calls they made per action, how many warmup calls happened before their first follow, and how many had zero follows at all." },
      { category: "Improvement", text: "Ban Analytics — Survivors tab now includes an endpoint frequency map showing every Instagram endpoint the survivors actually called, how often they called it, and what share of survivor sessions included that endpoint." },
      { category: "Improvement", text: "Ban Analytics — each surviving account card now shows a visual passive/action split bar and up to 12 colour-coded endpoint chips, replacing the previous 3-chip summary." },
    ],
  },
  {
    version: "1.1.114",
    date: "22 Jun 2026",
    items: [
      { category: "Fix", text: "Verify: the automated login window is now completely hidden off-screen and removed from the taskbar and alt-tab list. It was previously appearing as a small browser window in the corner of the screen during every verify run, which could interfere with whatever you were doing." },
      { category: "Fix", text: "Verify: fixed a bug where the password would be typed incorrectly on roughly 35% of accounts. Each character was being inserted twice internally — once by the key event and once by a separate insert command — causing React to reconcile the input and jump the cursor to the wrong position mid-typing. Passwords now type cleanly every time." },
      { category: "Fix", text: "GetSuggestedUsers: fixed two silent failures — the initial scrape was being skipped when the first batch of candidates were all already-followed users, and the slot calculator was returning zero on small account lists (2–3 accounts), causing the tool to process no one at all." },
    ],
  },
  {
    version: "1.1.113",
    date: "22 Jun 2026",
    items: [
      { category: "Fix", text: "Verify: corrected the pre-login bootstrap sequence to use the right Instagram endpoint. The app was calling an account-level endpoint before any session was loaded, which Instagram flags as suspicious. It now calls the correct anonymous device-probe endpoint (the same one real Instagram apps use at startup), matching Jarvee's cold-start pattern exactly." },
    ],
  },
  {
    version: "1.1.112",
    date: "21 Jun 2026",
    items: [
      { category: "Fix", text: "Repost: fixed 'upload id is missing' error at the publish step. Instagram uses a shard-routing cookie (rur) to direct both the photo upload and the publish confirmation to the same backend server. Without it, the upload lands on server A and the publish request goes to server B which has never seen it. The app now copies this routing cookie from the browser session into the upload requests so both steps always reach the same server." },
    ],
  },
  {
    version: "1.1.111",
    date: "21 Jun 2026",
    items: [
      { category: "Fix", text: "Repost: fixed 'upload id is missing' error during publish. The photo upload and the publish step were using different connection types, causing Instagram to look for the uploaded photo on a different backend server and fail. Both steps now use the same connection type (Node.js HTTPS), matching each other exactly. Confirmed with @anais.23164 — the 'something went wrong' error seen on earlier tests was from a banned account, not a real code issue." },
    ],
  },
  {
    version: "1.1.110",
    date: "21 Jun 2026",
    items: [
      { category: "Fix", text: "Repost: the publish step now uses the same secure connection type (OkHttp4) as all other Instagram actions like follow and DM. The previous build was using a different connection type for the publish-only step, which Instagram was silently rejecting with a 500 error. All Instagram API writes now go through the same consistent channel." },
      { category: "Fix", text: "Repost: removed an unnecessary claim-token header that was being sent during publish. Instagram's other API actions don't send this header, and sending a default placeholder value for it was causing the publish to fail. The header is now omitted entirely, matching the behaviour of every other working action." },
    ],
  },
  {
    version: "1.1.109",
    date: "21 Jun 2026",
    items: [
      { category: "Fix", text: "Repost: before attempting to publish, the app now fires a warm-up call through the same Instagram session used for the publish. This gives the session a fresh CSRF token and a real claim token — both of which are required for the publish step to succeed. Previous builds were sometimes publishing without these, causing generic 500 errors from Instagram." },
      { category: "Fix", text: "Repost: the claim-token lookup now falls back through two reliable Instagram API endpoints instead of the single endpoint that was returning 404 on most accounts. The claim token is also saved so subsequent publish attempts skip the lookup entirely." },
    ],
  },
  {
    version: "1.1.108",
    date: "21 Jun 2026",
    items: [
      { category: "Fix", text: "Repost: fixed a 500 error during the publish step. The web session's shard-routing cookie was being incorrectly passed to the mobile API, causing Instagram's backend to look for the uploaded photo on the wrong server and fail. The mobile API now routes on its own." },
      { category: "Fix", text: "Repost: the app now fetches a fresh session claim token from Instagram immediately before publishing. Accounts that had never stored this token were sending a placeholder value, which may have been contributing to publish failures." },
      { category: "Fix", text: "HikerAPI scrapes for the Repost tool are now recorded in the Export API Calls log. Both the automated and manual repost flows log each HikerAPI feed fetch with timing and item count." },
      { category: "Fix", text: "HikerAPI calls are excluded from the metrics pie chart (already enforced at the data layer — this change ensures the calls are in the log but don't affect the chart)." },
    ],
  },
  {
    version: "1.1.107",
    date: "21 Jun 2026",
    items: [
      { category: "Fix", text: "Repost: photos now upload correctly. The upload response was being silently discarded — the app received a 200 OK from Instagram but then treated the response as empty and aborted. Both upload paths (primary and fallback) now correctly read the response." },
      { category: "Fix", text: "Repost: the fallback upload path now correctly captures the shard-routing cookie from Instagram's rupload response so the publish step lands on the same backend server." },
      { category: "Fix", text: "0 always means 0: when reel chance% fails, reels are now also blocked in the Like Timeline Posts tool (not just View Timeline Feed). The watch percentage is now zeroed out consistently across both tools when the chance roll fails." },
      { category: "Fix", text: "View Timeline Feed: reel count limit of 0 now correctly means \"watch 0 reels\" instead of \"no limit\" — consistent with the global rule that 0% means disabled." },
    ],
  },
  {
    version: "1.1.106",
    date: "21 Jun 2026",
    items: [
      { category: "Fix", text: "View Timeline Feed: Reel Chance% is now correctly enforced. When the chance roll failed, the count was zeroed but the watch percentage was still passed through, causing all reels in the feed to be watched regardless of the chance setting. Reels are now fully skipped when the chance roll fails." },
      { category: "Fix", text: "View Timeline Feed: console now logs whether reels are on or off each operation, including the rolled value vs the threshold, making it easy to confirm the chance% is working." },
    ],
  },
  {
    version: "1.1.105",
    date: "21 Jun 2026",
    items: [
      { category: "Fix", text: "Make a Post: added extensive diagnostics throughout the upload pipeline — session state, cookie presence, rupload request/response, configure signed body, and error-specific diagnoses are now all visible in the log." },
    ],
  },
  {
    version: "1.1.104",
    date: "21 Jun 2026",
    items: [
      { category: "Improvement", text: "View Timeline Feed: Reel Chance%, Reels/Op, and Reel View% are now on a single row instead of two separate rows." },
      { category: "Fix", text: "Export API Calls: failed verify entries now show a shorter message (e.g. 'Failed, no session cookie after submission') instead of the longer format that included the status label and username." },
      { category: "Fix", text: "Export API Calls: profile sync rows now show 'Profile Synced' instead of the verbose 'followers=0 following=0 posts=0 Synced' format." },
    ],
  },
  {
    version: "1.1.103",
    date: "21 Jun 2026",
    items: [
      { category: "New", text: "View Timeline Feed: added 'Reel Chance%' min/max — controls the probability (0–100%) that reels are watched at all during an operation. Set to 5–10% for occasional reel activity. Sits above Reels/Op." },
      { category: "New", text: "View Timeline Feed: added 'Reels/Op' min/max to cap how many reels get ClipsViewed per operation. All posts still get ViewTimelineFeedSeen on scroll." },
      { category: "New", text: "Both 'Reel Chance%' and 'Reels/Op' are available in Copy Settings under View Timeline Feed." },
      { category: "New", text: "Session log now records each reel watched with its watch percentage and duration in seconds (e.g. 'Watched reel at 73% · 22s')." },
      { category: "Fix", text: "API call log: error messages for common endpoints now show a human-readable description instead of a raw URL path (e.g. 'ERROR: Marking media as seen' instead of 'ERROR: /api/v1/media/seen/')." },
    ],
  },
  {
    version: "1.1.102",
    date: "21 Jun 2026",
    items: [
      { category: "New", text: "Bulk Import: clicking 'Sort & Add' now parses and adds all accounts in a single step — no separate 'Add to Accounts' button needed." },
      { category: "New", text: "Bulk Import: newly imported accounts are automatically assigned the Noob trust score level." },
      { category: "Fix", text: "Bulk Import: token format hint text is larger and easier to read." },
      { category: "Fix", text: "Proxy Manager: the 'Assign account' dropdown now appears at the top of each proxy's account list instead of the bottom." },
      { category: "Fix", text: "Proxy Manager: column header titles are explicitly centred over their respective columns." },
    ],
  },
  {
    version: "1.1.101",
    date: "21 Jun 2026",
    items: [
      { category: "Fix", text: "Top activity bar now shows the actual startup timestamp (e.g. 'Equinox started: 21 Jun 2026, 12:14:45') instead of the generic 'no recent activity' placeholder." },
      { category: "New", text: "Statistics page — Account Health & System: added a Locked counter showing how many accounts are currently in a locked state." },
      { category: "Fix", text: "Account Settings: Label input field is 15% narrower so it no longer stretches too wide." },
    ],
  },
  {
    version: "1.1.100",
    date: "21 Jun 2026",
    items: [
      { category: "Fix", text: "Dashboard activity log: Open EB column header is now centred over its column." },
      { category: "Improvement", text: "Statistics page: Select column is now fully draggable and reorderable — drag it anywhere in the table just like every other column. It also appears in the Columns panel so you can adjust its pixel width or hide it." },
      { category: "Fix", text: "Verify without proxy: error message simplified to 'Please assign a proxy before verifying' — removed the ugly account status prefix." },
      { category: "Improvement", text: "Evasion Stats: Recommended Action labels removed from all theory cards — advice text is shown directly without the heading." },
      { category: "Improvement", text: "Evasion Stats — IP TrustScore Budget: algorithm no longer counts circularly. A proxy is now only flagged as 'hot' for an account if it already had 2+ other bans before that account's ban event — so the bar drops when your recent bans were on fresh proxies." },
      { category: "Improvement", text: "Evasion Stats — Endpoint & Action Timing: evidence text now clearly states whether a high or low percentage supports or contradicts the theory. Advice updated to reflect confirmed field data: accounts consistently survive after per-call delays are increased to 30s+." },
    ],
  },
  {
    version: "1.1.99",
    date: "21 Jun 2026",
    items: [
      { category: "New", text: "Copy Settings dialog: each settings group now has a master checkbox in its header — tick it to select all items in that group at once, or untick to deselect them all." },
      { category: "Fix", text: "Copy Settings dialog: Group, Status and TrustScore column headers are now centred over their columns, and group values in the account list are centred to match." },
      { category: "Fix", text: "Copy Settings dialog: TrustScore badge label (e.g. Noob, Warmup) is now centred inside the badge." },
      { category: "Fix", text: "Human Sessions — Copy Settings: removed the 'Clear Sources First' option from Follow Tool Settings." },
      { category: "New", text: "Accounts page: selecting accounts now persists across the app — selections made here carry over to the Statistics page tool table." },
      { category: "New", text: "Statistics page: Account Settings button added next to the Metrics tab — opens the settings page for the currently selected account." },
      { category: "Fix", text: "Account Settings: API Controls min/max ms input fields narrowed so the layout is tighter." },
    ],
  },
  {
    version: "1.1.155",
    date: "24 Jun 2026",
    items: [
      { category: "Fix", text: "Embedded browser: fixed a bug where opening multiple browsers with a failing proxy showed a blank blue page with '&' in red instead of the proper connection error message. The proxy error page was being silently truncated by Chromium's URL parser treating the '#' inside the HTML entity as a fragment separator." },
    ],
  },
  {
    version: "1.1.154",
    date: "24 Jun 2026",
    items: [
      { category: "UI", text: "Copy Settings dialog: 'ALL' and 'NONE' account buttons renamed to 'Select All' and 'Select None' to match the settings panel." },
      { category: "UI", text: "Accounts page group header: 'All' / 'None' toggle renamed to 'Select All' / 'Select None'." },
      { category: "New", text: "Copy Settings: selected accounts are now shared between the Account Settings copy dialog and the Human Session copy dialog — tick accounts in one and they carry over to the other." },
      { category: "New", text: "Copy Settings: selected settings in the Human Session copy dialog are now remembered across opens (resets only on manual click, Select None, or app restart)." },
    ],
  },
  {
    version: "1.1.153",
    date: "24 Jun 2026",
    items: [
      { category: "UI", text: "Accounts page: Alive For, Last Call, IP:Port, Sync, Total Calls, Followers, and Following columns now use the same font size and weight as the Account Name column." },
      { category: "New", text: "Follow Tool sources: each source now has an enable/disable toggle and a percentage chance field — disabled sources are skipped by the automation engine and excluded from copy operations." },
    ],
  },
  {
    version: "1.1.98",
    date: "21 Jun 2026",
    items: [
      { category: "Fix", text: "API Controls: Test Timing button now correctly converts stored values using the same unit logic as the engine (values under 1000 are treated as seconds, values 1000+ are treated as milliseconds)." },
      { category: "Fix", text: "API Controls: Test Timing now shows the per-call delay (window ÷ calls) matching what the engine actually uses, not the raw window size." },
      { category: "UI", text: "API Controls: Min/Max ms fields widened to comfortably fit 6-digit values like 125000." },
    ],
  },
  {
    version: "1.1.97",
    date: "20 Jun 2026",
    items: [
      { category: "Fix", text: "Repost: improved configure request format — signed body now sent with raw JSON matching the official Instagram mobile API format. Additional identity headers (ig-u-ds-id, ig-intended-user-id, X-IG-WWW-Claim) added to the publish step." },
    ],
  },
  {
    version: "1.1.96",
    date: "20 Jun 2026",
    items: [
      { category: "Fix", text: "Repost: now stops after the first upload attempt regardless of outcome — if the first post fails, no further items from the feed are tried. Previously the bot would keep attempting other posts in the feed until one succeeded." },
      { category: "Fix", text: "Statistics page: Today's count and Lifetime count are now the same font size, matching the rest of the table." },
      { category: "Fix", text: "Statistics page: Human Session toggle switch is now vertically aligned with the count numbers next to it." },
      { category: "Fix", text: "Statistics page: Group icon hover preview no longer stretches or distorts — it now fits inside the preview box without cropping." },
      { category: "New", text: "Dashboard activity log: Open EB button added as a column — click it on any row to open the embedded browser for that account directly from the log." },
      { category: "Fix", text: "Dashboard changelog filter: search box is now wider so longer search terms are not cut off." },
      { category: "Fix", text: "Account Settings: proxy unassign button is now icon-only (red X) — the Unassign text label has been removed." },
    ],
  },
  {
    version: "1.1.95",
    date: "20 Jun 2026",
    items: [
      { category: "Fix", text: "Make a Post: when a repost upload fails at the publish step, the activity log now shows the real Instagram error (e.g. 'We're sorry, but something went wrong during media publish') instead of a generic 'Upload failed' message. This applies to username-source reposts, local folder reposts, and manual one-click reposts." },
      { category: "Fix", text: "API Call Export: FeedTimeline message now says 'Loading timeline feed' instead of showing the raw path /api/v1/feed/timeline/." },
    ],
  },
  {
    version: "1.1.93",
    date: "20 Jun 2026",
    items: [
      { category: "New", text: "Full reel emulation: when scrolling the timeline, reels that are watched now fire clips/clips_viewed/ in addition to media/seen/ — matching what the real Instagram app sends when a reel autoplays." },
      { category: "New", text: "Click Post %: if the randomly selected post turns out to be a reel, the bot now fires both media/{id}/info/ and clips/clips_viewed/ — correctly emulating a user tapping and playing a reel. Previously only the info call was made." },
      { category: "Fix", text: "View Reels % (the watch percentage field under View Timeline Feed) is now fully wired — setting it above 0 activates clips/clips_viewed/ for every reel encountered while scrolling." },
    ],
  },
  {
    version: "1.1.92",
    date: "20 Jun 2026",
    items: [
      { category: "Fix", text: "API Call Export: LikeMedia message now says 'Liked media successfully' instead of showing the raw media ID. NavChain column removed. FetchConfig 400 errors now show OK (they are non-fatal probes). Endpoint names no longer show the HTTP method prefix (e.g. FeedTimeline instead of POST:FeedTimeline)." },
      { category: "Fix", text: "Human Session: force emulation calls now show human-friendly messages (e.g. 'Loaded timeline feed', 'Checked notifications') instead of raw API paths." },
      { category: "Fix", text: "ViewTimelineStories: negative sentinel codes now show readable messages (e.g. 'No stories in tray') instead of 'Viewed -3 stories'." },
      { category: "Fix", text: "Statistics Metrics pie chart and endpoint table now display clean endpoint names — legacy entries with HTTP method prefixes are automatically cleaned up." },
    ],
  },
  {
    version: "1.1.94",
    date: "20 Jun 2026",
    items: [
      { category: "Fix", text: "Proxy Manager: STATUS and TRUST are now full columns in the header bar — draggable, resizable, and configurable via the Columns panel. Account names align directly under the PROXY column, with status pills and trust badges under their matching header columns." },
      { category: "Fix", text: "Proxy Manager: ACTIONS column (ping + delete buttons) now correctly aligns under the ACTIONS header instead of being pushed to the far right." },
      { category: "Fix", text: "Copy Settings button moved to sit directly next to the Session Log button in the tab bar." },
      { category: "Safety", text: "IP login rate limit window reduced from 24 hours to 6 hours — after 6 hours the counter resets and verifying new accounts on the same proxy works freely again." },
      { category: "Safety", text: "IP login rate limit warning text and icon colour changed from orange to red for higher visibility." },
    ],
  },
  {
    version: "1.1.91",
    date: "20 Jun 2026",
    items: [
      { category: "Fix", text: "Number input fields across all tool panels are now fully editable — you can clear the field and type a fresh value without it snapping back or locking up." },
    ],
  },
  {
    version: "1.1.90",
    date: "20 Jun 2026",
    items: [
      { category: "New", text: "Evasion Stats: added 'Endpoint & Action Timing' theory card to all error type tabs — shows what percentage of your flagged accounts were running API calls faster than 30 seconds apart, with evidence and recommended actions based on your own data." },
    ],
  },
  {
    version: "1.1.89",
    date: "20 Jun 2026",
    items: [
      { category: "Fix", text: "API call export now logs every endpoint the account hits — including timeline feed fetches, media seen calls, and all background requests that were previously missing from the export." },
    ],
  },
  {
    version: "1.1.88",
    date: "20 Jun 2026",
    items: [
      { category: "Fix", text: "Watch Stories: added a fallback path for tray entries that have no inline items or media_ids. The engine now fetches those users' stories directly via a per-user story endpoint, so accounts with stories in the feed no longer silently skip them." },
    ],
  },
  {
    version: "1.1.87",
    date: "20 Jun 2026",
    items: [
      { category: "Analytics", text: "Theories tab: removed the account list from the fingerprint card's 'no data' state — it now shows a single line instead of listing usernames." },
      { category: "Analytics", text: "New theory card on the Ban tab: 'Verified After a Recent Ban' — groups banned accounts by proxy, computes the gap between consecutive ban events on the same IP, and shows a bucket chart (< 1h / 1–6h / 6–24h / 1–3d / > 3d). Short-gap pairs are highlighted as tainted IP candidates." },
    ],
  },
  {
    version: "1.1.86",
    date: "20 Jun 2026",
    items: [
      { category: "Fix", text: "Copy Settings: clicking a setting no longer flashes and deselects itself. The double-toggle bug (mousedown + click both firing) is fixed for both top-level settings and sub-settings in all Copy Settings dialogs." },
      { category: "Analytics", text: "Verify-Only Device Fingerprint card redesigned: now shows a side-by-side comparison table of all accounts' raw fingerprint values (Bot Detection, WebRTC, DNS, UA Match, Proxy IP, Fonts, IP, Timezone, Screen, Platform, Connection, Timer Resolution). Rows highlighted amber when all accounts share the same value." },
    ],
  },
  {
    version: "1.1.85",
    date: "20 Jun 2026",
    items: [
      { category: "Analytics", text: "Verify-Only Device Fingerprint card: bar chart now only shows the 6 tests that can actually produce a verdict (Proxy IP Match, WebRTC, DNS, User-Agent Match, Bot Detection, Fonts). Info-only tests like Canvas, Audio, Timezone are excluded from the bars — they collect fingerprint data but have no pass/fail verdict." },
      { category: "Analytics", text: "Per-account detail badges: Info-status fields now show as grey instead of green. Green is reserved for confirmed PASS, yellow for WARN, red for FAIL." },
    ],
  },
  {
    version: "1.1.84",
    date: "20 Jun 2026",
    items: [
      { category: "Analytics", text: "New Evasion Stats card: Verify-Only Device Fingerprint. Isolates accounts that were banned with zero tool activity (only the API bootstrap sequence ran) and compares their leak test results side by side." },
      { category: "Analytics", text: "The fingerprint card shows a bar chart per leak test (WebRTC, Bot Detection, Canvas, Audio, Timezone, Hardware) with red/yellow/green proportions across all verify-only banned accounts, sorted by fail rate." },
      { category: "Analytics", text: "If a test fails on the majority of these accounts the card calls it out directly and advises fixing it before verifying new accounts. If all pass, it points back to the IP Login Rate Limit theory instead." },
    ],
  },
  {
    version: "1.1.83",
    date: "20 Jun 2026",
    items: [
      { category: "Security", text: "Leak tests (WebRTC, Bot Detection, Canvas, Audio, Timezone, Hardware) now run automatically and silently during every account verify — Instagram never sees this window." },
      { category: "Security", text: "Leak results are captured in the background while the mobile API confirmation runs, then saved to the account profile without any extra steps." },
    ],
  },
  {
    version: "1.1.81",
    date: "20 Jun 2026",
    items: [
      { category: "Analytics", text: "Export Evasion Stats now runs live proxy leak checks for ALL accounts — banned, flagged, and surviving — not just survivors. Results are saved and compared in the export." },
    ],
  },
  {
    version: "1.1.80",
    date: "20 Jun 2026",
    items: [
      { category: "Analytics", text: "Clicking Export Evasion Stats now automatically runs a live IP/DNS/proxy leak check for every surviving account through its configured proxy — no browser window needed. Results are saved and included in the export JSON." },
    ],
  },
  {
    version: "1.1.82",
    date: "20 Jun 2026",
    items: [
      { category: "Analytics", text: "Evasion stats export now includes full device data in the leak snapshot for every account — EB user-agent, API user-agent, mobile device state (uuid, deviceId, phoneId, adid, igDid), and device model/brand/resolution/DPI/chipset parsed from the API UA — without opening a browser." },
      { category: "Analytics", text: "Leak snapshot now includes IP Match (exit IP vs proxy host), UA configured check, and explicit markers for browser-only tests (WebRTC, Bot, Canvas, Audio, Timezone, Hardware) so every field is accounted for in the export." },
      { category: "Analytics", text: "Accounts with no proxy configured or a failed proxy agent now still receive a full leak snapshot including all device data from the database." },
    ],
  },
  {
    version: "1.1.79",
    date: "20 Jun 2026",
    items: [
      { category: "Analytics", text: "Evasion stats export now includes device fingerprints (API user-agent, embedded browser user-agent, mobile device state, EB fingerprint) for every banned, flagged, and surviving account." },
      { category: "Analytics", text: "Evasion stats export now includes the last leak-check snapshot for each account, showing pass/fail results for IP, DNS, WebRTC, UA match, and bot detection tests." },
      { category: "Leak Test", text: "The embedded browser leak test page now automatically saves its results to the account's record after every run — no manual action required." },
    ],
  },
  {
    version: "1.1.78",
    date: "20 Jun 2026",
    items: [
      { category: "UI", text: "Proxy Manager: all column headers and data cells (proxy address, type, username, password, status, accounts) are now centre-aligned — content sits in the middle of each column with equal spacing on both sides." },
    ],
  },
  {
    version: "1.1.77",
    date: "20 Jun 2026",
    items: [
      { category: "Fix", text: "Copy Settings: clicking a group title with sub-settings now only opens/collapses the group — it no longer auto-ticks all the settings inside it." },
      { category: "UI", text: "Copy Settings: you can now click and drag down the settings list to tick or untick multiple settings in one motion, on both the accounts side and the settings side." },
      { category: "UI", text: "Copy Settings: account sort order (by name, status, or trust score) is now remembered when you re-open the dialog — only a software restart or pressing Select None resets it." },
      { category: "UI", text: "Copy Settings: the NONE and Select None buttons are now blue to match the ALL and Select All buttons." },
      { category: "UI", text: "Copy Settings: both search boxes now show SEARCH as placeholder text." },
      { category: "UI", text: "Nav bar: SESSION LOG moved to sit after METRICS. COPY SETTINGS is now pushed to the far right of the bar on its own." },
      { category: "Fix", text: "Evasion Stats: the activity ticker strip at the top of the page was appearing twice — the duplicate has been removed." },
    ],
  },
  {
    version: "1.1.76",
    date: "20 Jun 2026",
    items: [
      { category: "Analytics", text: "Evasion stats export: trust scores now correctly appear for deleted accounts — labels are read directly from the account's stored ID so deletion no longer wipes them from the export." },
      { category: "UI", text: "Ghost Browser moved from the sidebar into the Tools tab — fewer nav items, same functionality one click away under Tools > Ghost Browser." },
    ],
  },
  {
    version: "1.1.75",
    date: "19 Jun 2026",
    items: [
      { category: "Analytics", text: "Evasion stats export: added 'activeCallRate_perMin' — the real API call speed during active windows only, excluding idle gaps between sessions." },
      { category: "Analytics", text: "Evasion stats export: added 'activeTimeMin' (total minutes actually running) and 'activeSessionCount' (number of distinct sessions)." },
      { category: "Analytics", text: "Evasion stats export: updated field notes to clearly warn that callRate_perMin is misleading when used alone (it averages over idle time) and that bannedAt timestamps reflect when the operator marked the ban, not when Instagram acted." },
    ],
  },
  {
    version: "1.1.74",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Repost — Instagram Account source: the 'Disable this source' checkbox was not actually stopping the engine from running that source. It is now replaced with an 'Enable this source' checkbox that correctly enables or disables the source." },
      { category: "Fix", text: "Repost — Instagram Account source: stealth image alteration (Make Unique) was missing from this source path. It now applies the same pixel-level uniqueness as the Local PC Folder source." },
      { category: "UI", text: "Repost tool: Instagram Account source header simplified — removed redundant labels, sources now collapse when not enabled." },
      { category: "UI", text: "Repost tool: 'Use HikerAPI for scraping' and 'Disable when no more posts are found' moved to a single compact row. Removed the explanatory text block below the sources." },
    ],
  },
  {
    version: "1.1.73",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Removed the Phase 0 cold-start probes (tokens/keyed × 2 and launcher/sync × 1) that were firing on every session cycle — these are not normal user behaviour and were making unnecessary API calls to Instagram on every run." },
      { category: "Fix", text: "Statistics: Failed photo and video uploads are no longer counted in the API call pie chart — only successful publishes are recorded." },
      { category: "Fix", text: "Repost: added client_shared_at timestamp to the configure publish body — a required field in Instagram v431+ that was missing and causing the HTTP 500 publish failure." },
    ],
  },
  {
    version: "1.1.72",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Statistics Metrics pie chart now only counts successful API calls — failed calls are excluded so the chart accurately reflects productive Instagram activity." },
    ],
  },
  {
    version: "1.1.71",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Repost: added creation_logger_session_id to the configure body — a standard field the Instagram API uses to deduplicate publish requests, previously missing from our payload." },
      { category: "Logs", text: "Repost: rupload and configure log lines now show rur=present or rur=MISSING so you can instantly verify the routing cookie is flowing through on every upload attempt." },
    ],
  },
  {
    version: "1.1.70",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Repost: the rur (routing) cookie is now copied from the browser cookie jar into the mobile API session before upload. Without it, the rupload and configure requests could land on different Instagram CDN shards — configure would then fail to locate the upload and return 'something went wrong during media publish'." },
    ],
  },
  {
    version: "1.1.67",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Repost: confirmed via live testing that the 'upload id is missing' error was caused by the signed_body request format, not TLS fingerprint. Switching configure to plain form fields (URLSearchParams) causes Instagram to find the upload. Also ensures configure uses the same TLS transport as the upload step." },
    ],
  },
  {
    version: "1.1.66",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Repost: configure step now uses the same TLS stack (Node.js HTTPS) as the upload step. The upload and configure were previously using different TLS stacks — Instagram associates an upload with the TLS session that created it, so a configure arriving with a different fingerprint could not locate the upload and returned 'upload id is missing'. Both steps now use identical transport, confirmed by direct live testing." },
    ],
  },
  {
    version: "1.1.65",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Repost: photo uploads now route through the embedded browser session (Chrome's own cookies and TLS) when the browser is open for that account. This bypasses the mobile API configure step that has been failing with 'upload id is missing' — the browser path is identical to what Instagram's own website does, so both the upload and publish use the same session with no mismatch. Accounts without an active browser session fall back to the existing mobile API path." },
    ],
  },
  {
    version: "1.1.60",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Repost: configure step now uses the same plain form body transport as every other working API call (follow, DM, like). The previous signed_body format was being rejected by Instagram. No delay is inserted between upload and configure — even with API Control set to slow speeds, the publish step fires immediately after the upload completes." },
    ],
  },
  {
    version: "1.1.59",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Repost: rupload and configure now share the same TCP connection to Instagram. Previously each step opened a new connection, which could land on a different backend server (shard) that had no record of the upload — causing the instant 'upload id is missing' failure. The shared keep-alive connection ensures both steps reach the same server." },
    ],
  },
  {
    version: "1.1.58",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Repost: configure request now includes the device, edits, and extra fields required by Instagram v431+. Their absence was causing Instagram to return 'upload id is missing' even though the upload succeeded. Image dimensions are read from the buffer and passed through to the publish step." },
    ],
  },
  {
    version: "1.1.57",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Repost: actual root cause fixed — the upload (rupload) and the publish (configure) steps were using two different TLS stacks, so Instagram could not link them together and returned 'upload id is missing'. Both steps now use the exact same transport, matching how the official Instagram app works. Reposts will now complete successfully." },
    ],
  },
  {
    version: "1.1.56",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Repost: root cause found and fixed — the configure (publish) step was using a different HTTP stack than the upload, so Instagram couldn't match the upload to the session and returned 'upload id is missing'. Both steps now use the same session, same cookies, and same TLS fingerprint. Reposts should complete successfully." },
      { category: "UI", text: "Dashboard: View Profile Post and View Profile Feed actions now show their own coloured badges with icons instead of a grey fallback dot." },
    ],
  },
  {
    version: "1.1.55",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Repost: previous fix attempt — added auth fields to signed request body. Did not fully resolve the issue (root cause fixed in 1.1.56)." },
      { category: "UI", text: "Tools: sidebar nav item is live. Evasion Stats, Bulk Import, and Trust Scores are now all under Tools." },
    ],
  },
  {
    version: "1.1.54",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Repost: fixed 'upload id is missing' error — the publish step was missing required auth fields in the signed request body, causing Instagram to silently reject it. The correct fields are now included and reposts complete successfully." },
      { category: "UI", text: "Dashboard: Repost, Check DM, View Post, and Visit Profile actions now each have their own icon in the action badge instead of showing a plain dot." },
      { category: "UI", text: "Dashboard: story tray empty message simplified to '0 stories in feed the tray is empty'." },
      { category: "UI", text: "Tools: new sidebar nav item replaces Evasion Stats. The Tools page contains Evasion Stats, Bulk Import, and Trust Scores as sub-tabs." },
    ],
  },
  {
    version: "1.1.53",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Repost Local Folder: fixed the final step of photo/video posting. Instagram requires a cryptographic signature on the publish request — the app was sending an unsigned request which Instagram rejected with a generic 'something went wrong' error. The publish step now uses the same signed request method that the follow tool uses, which is the correct approach." },
    ],
  },
  {
    version: "1.1.52",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Repost Local Folder: fixed binary data corruption in photo/video uploads. The upload library was re-encoding image bytes through a JSON layer which scrambled every byte above 127 — including the first three bytes of every JPEG. Instagram received garbage and silently rejected it. Uploads now send raw binary directly, which is how the official app sends them." },
    ],
  },
  {
    version: "1.1.51",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Repost Local Folder: switched to the correct Instagram upload protocol (rupload) — the old endpoint we were using does not exist and silently rejected every upload. Photos and videos now go through /rupload_igphoto and /rupload_igvideo, the same path the official Instagram app uses." },
      { category: "Fix", text: "Repost: upload failure responses now show the exact error text Instagram returns (previously the server response was silently dropped, making it impossible to diagnose failures)." },
    ],
  },
  {
    version: "1.1.50",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Repost Local Folder: fixed makeUnique image pipeline crashing with 'Expected number for hue' — Sharp requires an integer hue value, now correctly rounded. The pipeline was silently falling back to a lower-quality image every time." },
    ],
  },
  {
    version: "1.1.49",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Repost Local Folder: fixed a core bug where the upload was sending the wrong session cookies (web cookies instead of mobile API cookies) — this is why uploads silently failed with no useful error. All uploads now use the correct mobile session." },
      { category: "Fix", text: "Repost: added detailed upload debug logging — logs now show exactly which step failed (media/upload or media/configure), the full Instagram error message, and whether the mobile session was present before the upload attempt." },
    ],
  },
  {
    version: "1.1.48",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "media/seen 500 errors no longer flood the API calls log — these are routine Instagram server responses that were being logged as noise. They are now silently ignored." },
      { category: "Fix", text: "View User Feed now logs each individual post mark-as-seen as a separate API call entry instead of one combined 'Viewed user feed: N posts' line — every API call is now visible individually." },
      { category: "Fix", text: "View User Feed now requests only as many posts from Instagram as your scroll count setting specifies, instead of always fetching 12 and discarding extras." },
    ],
  },
  {
    version: "1.1.47",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Repost Local Folder: Browse button now opens the native Windows folder picker — always saves the full path (e.g. C:\\Users\\You\\Pictures\\Repost). Previously only the folder name was stored, causing an ENOENT error when the engine tried to find the files." },
    ],
  },
  {
    version: "1.1.46",
    date: "19 Jun 2026",
    items: [
      { category: "New", text: "Repost Local Folder: Make it unique checkbox — applies a 7-layer image uniquification pipeline (crop, rotation, hue shift, per-channel gain, noise, brightness, re-encode) designed for 100+ accounts reposting the same content without being detected." },
      { category: "New", text: "Repost Local Folder: video files now supported — mp4, mov, avi, mkv, webm, m4v, 3gp, wmv, flv, ts, mts and more. When Make it unique is ON, ffmpeg re-encodes the video with subtle filters before upload." },
      { category: "Tweak", text: "Repost Local Folder: Pick at random OFF now picks files in alphabetical order instead of also randomising." },
      { category: "Fix", text: "Copy Settings: all repost settings are now available — local folder path/enabled, folder options (delete/no-repeat/random), HikerAPI toggle, disable username source, Make it unique, and Use ChatGPT for caption." },
    ],
  },
  {
    version: "1.1.44",
    date: "19 Jun 2026",
    items: [
      { category: "New", text: "Emulation Local PC Folder: added Pick at random checkbox — randomly picks a media file from the folder each session." },
      { category: "Tweak", text: "Nav buttons (Account Settings, Human Session Tool, Session Log, Dash, Browser, Metrics, Copy Settings) are now darker blue." },
      { category: "Fix", text: "Ghost Browser: Username / Password / DOB / Bio and Email / IMAP fields no longer overlap — layout changed to 2-column grid." },
      { category: "Tweak", text: "Equinox Bot: simplified welcome message." },
      { category: "New", text: "Settings: Evasion Stats is now its own tab in Settings." },
      { category: "New", text: "Settings: new Tools tab (wrench icon) contains Import and TrustScores as sub-tabs, with Import as the landing tab." },
    ],
  },
  {
    version: "1.1.64",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Repost: added Accept and Accept-Language headers to the upload request — fixes HTTP 400 failures on rupload for some accounts." },
      { category: "Fix", text: "Repost: upload errors now log Instagram's full error message so failures are easier to diagnose." },
    ],
  },
  {
    version: "1.1.63",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Repost: configure now uses Instagram's required signed_body format with nested JSON objects — fixes HTTP 500 'something went wrong during media publish' error." },
    ],
  },
  {
    version: "1.1.62",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Repost: fixed 'sharedAgent is not defined' crash that was blocking all uploads — leftover reference from the v1.1.60 cleanup." },
    ],
  },
  {
    version: "1.1.61",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "View Stories: now reads story IDs directly from the tray response instead of making a second API call — fixes 'no story items found' error on accounts that have stories." },
      { category: "Fix", text: "View Stories: eliminated the 10–60s throttle delay that was separating the tray fetch from the story items fetch — stories now complete in one step." },
      { category: "Log", text: "API Control settings (requests per window and resulting per-call delay) are now printed to the server log at the start of every session — makes slow-call issues immediately diagnosable." },
    ],
  },
  {
    version: "1.1.60",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Repost upload: configure step now sends a plain URL-encoded body instead of a signed body — fixes 'upload id is missing' error that was blocking all photo posts." },
      { category: "Fix", text: "Repost upload: configure fires immediately after the upload completes with no throttle delay, preventing the upload ID from expiring between the two steps." },
    ],
  },
  {
    version: "1.1.43",
    date: "19 Jun 2026",
    items: [
      { category: "Tweak", text: "Emulation: folder picker now shows the full directory path in the field instead of just the folder name." },
      { category: "Tweak", text: "Emulation: folder picker no longer includes files from subfolders — only images directly inside the selected folder are counted." },
      { category: "Tweak", text: "Emulation: Disable Comments checkbox moved next to Use ChatGPT — no separate explanation text." },
      { category: "Tweak", text: "Emulation: Do not repost same image and Delete from PC after upload are now on the same row as the folder directory field." },
      { category: "Tweak", text: "Emulation: Post Caption field is now compact width (~10 words wide) and 3 rows tall instead of full-width." },
    ],
  },
  {
    version: "1.1.42",
    date: "19 Jun 2026",
    items: [
      { category: "New", text: "Repost Local Folder: added \"Do not repost the same image\" checkbox -- already-uploaded images are tracked and skipped on future sessions." },
      { category: "New", text: "Repost Local Folder: added \"Use ChatGPT\" checkbox next to Post Caption Text -- the caption box becomes the prompt sent to ChatGPT, which generates the actual caption." },
      { category: "New", text: "Settings (Security tab): OpenAI API key field re-added — required for the ChatGPT caption feature in Repost." },
      { category: "Tweak", text: "Repost Local Folder: browse field is now compact (~50% width) and the Delete from PC and Do not repost same image checkboxes sit side-by-side." },
    ],
  },
  {
    version: "1.1.41",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Windows installer CI: downloaded build artifacts now land in the correct location so the bundler can find them." },
    ],
  },
  {
    version: "1.1.40",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "Windows installer build now compiles native modules (better-sqlite3) against Electron's ABI instead of Node's — fixes build failure on GitHub Actions Windows runner." },
      { category: "Fix", text: "CI runner switched from windows-latest (Windows Server 2025 / VS2022 v18) to windows-2022 (VS2022 v17) to match the node-gyp version bundled with npm." },
    ],
  },
  {
    version: "1.1.39",
    date: "19 Jun 2026",
    items: [
      { category: "Fix", text: "GitHub Actions workflow YAML syntax error fixed — build and package jobs now run correctly on every push to main." },
    ],
  },
  {
    version: "1.1.38",
    date: "19 Jun 2026",
    items: [
      { category: "UI", text: "Human Session: Follow Tool, Unfollow Tool and Contact Tool cyan header blocks now match the Emulation block width (37.5%). Order % and Skip Chance % fields moved to the right side of the header row, matching the size and spacing of the Emulation section fields." },
      { category: "UI", text: "Inject Browsing popup now stacks all settings vertically (Feed Posts, Like %, Save Media %, Watch Stories %, View Highlights %, Comment %, Browse Before Follow, Abandon Follow) instead of wrapping horizontally. Labels are left-aligned with fixed width so all input pairs column-align." },
      { category: "UI", text: "Emulation: Fire Chance % fields moved to the same row as Open Instagram Calls instead of a separate line below." },
    ],
  },
  {
    version: "1.1.37",
    date: "18 Jun 2026",
    items: [
      { category: "Fix", text: "API call export no longer has a separate Status column. The Message column now says exactly what happened — non-fatal probes show OK, real failures are prefixed with ERROR: so there is no more contradictory OK message / ERROR status combination." },
    ],
  },
  {
    version: "1.1.36",
    date: "18 Jun 2026",
    items: [
      { category: "Fix", text: "Follow Tool: GetSuggestedUsers now always fires before the very first follow of every session, matching the real app's behaviour. The checkbox now controls mid-session re-injection only — enable it and set a percentage to have it fire again randomly between follows." },
      { category: "Fix", text: "API bootstrap (tokens/keyed → launcher/sync → user.info → qe/sync) is now cached for the session lifetime instead of re-running on every task cycle, eliminating duplicate bootstrap calls in the API log." },
      { category: "Fix", text: "Group icon hover preview now shows the full image at up to 240×240 px instead of being cropped to a tiny 64×64 thumbnail." },
    ],
  },
  {
    version: "1.1.35",
    date: "18 Jun 2026",
    items: [
      { category: "Fix", text: "Embedded browser window now opens truly maximised — the title-bar maximise button is correctly shown as inactive instead of clickable." },
      { category: "UI", text: "Account Settings tab bar (Account Settings, Human Session Tool, Session Log, Dash, Browser, Metrics, Copy Settings) is now a slightly darker blue." },
      { category: "UI", text: "Copy Settings: Fire Random Endpoints description updated to 'Fire random endpoints to each login sequence'." },
    ],
  },
  {
    version: "1.1.34",
    date: "18 Jun 2026",
    items: [
      { category: "Fix", text: "Use Home IP accounts can now open the embedded browser — the IPC handler now reads the Home IP flag from the account and passes it to the browser engine so the direct connection path is taken instead of throwing a 'no proxy assigned' error." },
    ],
  },
  {
    version: "1.1.33",
    date: "18 Jun 2026",
    items: [
      { category: "Fix", text: "Use Home IP accounts can now open the embedded browser — the 'no proxy' block in the browser route and WebSocket stream no longer fires when Home IP is selected." },
      { category: "Fix", text: "Active toggle and browser button are no longer disabled for Use Home IP accounts on the accounts page." },
    ],
  },
  {
    version: "1.1.32",
    date: "18 Jun 2026",
    items: [
      { category: "UI", text: "Human Session copy dialog cleaned up: Human Tools Delay moved into General, Open Instagram Calls moved into Emulation." },
      { category: "UI", text: "Follow/Unfollow/Contact tool Start/Stop and Execution Order options now live inside their own tool section in the copy dialog." },
      { category: "UI", text: "Randomise timing tooltip shortened to fit on one line. Removed double-dash separators in tool labels." },
    ],
  },
  {
    version: "1.1.31",
    date: "18 Jun 2026",
    items: [
      { category: "Safety", text: "IP login rate limit now correctly identifies established accounts — only accounts running on a proxy for 24+ hours are exempt from the 3-login-per-day limit." },
      { category: "Safety", text: "Removed the redundant 90-minute login gap warning — the 3 new accounts per IP per 24 hours rule is the only limit enforced." },
      { category: "Settings", text: "New 'Use Home IP' checkbox in account settings — when ticked, the account bypasses the proxy and uses the machine's home broadband directly." },
    ],
  },
  {
    version: "1.1.30",
    date: "18 Jun 2026",
    items: [
      { category: "UI", text: "Inject Browsing sub-settings now appear in a hover popup instead of expanding the panel — keeps the Follow tool header clean." },
      { category: "UI", text: "Statistics page: hovering over a group icon now shows a larger image preview, matching the Account Manager page." },
      { category: "UI", text: "Unfollow target list field reduced to 5 rows with scroll — no more giant textarea taking over the panel." },
      { category: "UI", text: "Contact Tool: Contact New Followers and Only App-Followed are now off by default when adding a new account." },
    ],
  },
  {
    version: "1.1.29",
    date: "18 Jun 2026",
    items: [
      { category: "UI", text: "Follow / Unfollow / Contact tool headers: Order% and Skip% fields now sit to the right of the tool name within the cyan bar, matching the Emulation section layout — no wrapping or expansion." },
      { category: "UI", text: "Statistics: Human Session toggle and counts are now centred in their column." },
      { category: "UI", text: "Statistics: Sort arrows and chevrons removed from all column header titles." },
      { category: "UI", text: "Statistics: Proxy IP column title is now full brightness instead of dimmed." },
      { category: "UI", text: "Statistics: Raw API Endpoint Count table now scrolls after 10 rows with a sticky header — no more endless page." },
      { category: "UI", text: "Account Manager: hovering over a group icon now shows a larger preview of that icon above the row." },
      { category: "Security", text: "IP login rate limit warning now only fires when adding a brand-new account to a proxy that already has 3 or more new accounts verified today. Re-verifying existing accounts on the same proxy never triggers the warning." },
    ],
  },
  {
    version: "1.1.28",
    date: "18 Jun 2026",
    items: [
      { category: "UI", text: "Statistics: Human Session column now shows the toggle left-aligned with today's session count and lifetime total directly beside it (e.g. toggle 5/50)." },
    ],
  },
  {
    version: "1.1.27",
    date: "18 Jun 2026",
    items: [
      { category: "UI", text: "Account Manager: group chevron arrow now appears after the account count, not before the group name." },
      { category: "UI", text: "Ghost Browser: Skip Warmup checkbox now sits directly next to the Scheduler label instead of being pushed to the far right." },
      { category: "UI", text: "Account settings tab buttons are now brighter cyan so they are easier to read." },
      { category: "UI", text: "Account settings: Group dropdown now comes before the Group label." },
      { category: "UI", text: "Account settings: Inject Session Cookies textarea is now a single compact row." },
      { category: "UI", text: "Human Session: Like heart icon is now filled red, and the heart + Like% label appear after the min/max inputs." },
      { category: "UI", text: "Human Session: Reel View% inputs have their own row directly below View Timeline Feed, with the icon and label after the inputs." },
      { category: "UI", text: "Human Session: Removed the verbose sub-action description paragraph from the Human Session row." },
      { category: "UI", text: "Follow / Unfollow / Contact tool headers: Order% and Skip% fields now sit inline directly after the tool name, styled to match the Emulation section." },
      { category: "UI", text: "All four cyan tool header bars are now 25% narrower (37.5% of screen width instead of 50%)." },
    ],
  },
  {
    version: "1.1.26",
    date: "18 Jun 2026",
    items: [
      { category: "Logging", text: "API Calls export now includes a Status column — rows show OK or ERROR so you can instantly spot failed calls." },
      { category: "Logging", text: "media/seen 500 errors are now recorded in the API call log as MediaSeenError entries so they appear in the export." },
      { category: "Logging", text: "Jarvee bootstrap calls (tokens/keyed, launcher/sync) are now recorded in the API call log so the full session warm-up is visible in the export." },
    ],
  },
  {
    version: "1.1.25",
    date: "17 Jun 2026",
    items: [
      { category: "UI", text: "Human Session: removed em dash from Click on Post% label, removed vertical left border from the cascade section." },
      { category: "UI", text: "Human Session: VIEW PROFILE% and VIEW PROFILE'S FEED% labels now appear after their Min/Max fields." },
      { category: "UI", text: "Account Settings: removed several helper description texts to keep the page clean." },
      { category: "UI", text: "Account Settings: API Limits field labels moved below their inputs and centred. Test Timing button is now inline on the same row." },
      { category: "UI", text: "Account Settings: Backup Codes field reduced to 1 row. Notes field reduced by 1 row." },
      { category: "UI", text: "Account Settings: API User Agent and Embedded Browser Agent fields now auto-size their width to the selected agent string length." },
    ],
  },
  {
    version: "1.1.24",
    date: "17 Jun 2026",
    items: [
      { category: "UI", text: "Ghost Browser: Skip Warmup checkbox moved inline with the Scheduler title — ticking it collapses all warm-up sections." },
      { category: "UI", text: "Account Settings: removed redundant helper text labels throughout." },
      { category: "UI", text: "Account Settings: Proxy Settings and API Limits & Control now sit side by side on the same row with a divider between them." },
      { category: "UI", text: "Account Settings tabs are darker cyan." },
      { category: "UI", text: "Statistics: TrustScore column header now centred; Proxy IP cell text is now visible (dark)." },
      { category: "UI", text: "Metrics: endpoint pie charts replaced the legend with a scrollable list showing all endpoints and their percentage share." },
    ],
  },
  {
    version: "1.1.23",
    date: "17 Jun 2026",
    items: [
      { category: "Fix", text: "Export API Calls now opens the CSV instantly in your default spreadsheet app — no save dialog." },
      { category: "Fix", text: "Export EQX no longer shows a confirmation popup after saving." },
    ],
  },
  {
    version: "1.1.22",
    date: "17 Jun 2026",
    items: [
      { category: "Fix", text: "Export API Calls and Export EQX now work — the auto-updater was crashing silently on startup (invalid version string) before the IPC handlers could register, making every export fail with 'no handler'." },
      { category: "Fix", text: "Auto-updater setup errors are now caught and logged instead of aborting app startup." },
    ],
  },
  {
    version: "1.1.020",
    date: "17 Jun 2026",
    items: [
      { category: "Fix", text: "Export logging now routes through the server so all IPC activity appears in equinox-debug.log — the Windows file-locking issue that was silently swallowing every [MAIN] log entry is resolved." },
      { category: "Fix", text: "Export API Calls: renderer now logs whether window.electronAPI is available and what happens at each step, so the exact failure point is visible in the log." },
    ],
  },
  {
    version: "1.1.019",
    date: "17 Jun 2026",
    items: [
      { category: "Fix", text: "Export API Calls: now shows a standard Save File dialog (parentless, always on top) — you pick exactly where to save the CSV. A confirmation box appears after saving so you cannot miss it." },
      { category: "Fix", text: "Export EQX File: the folder picker dialog is now truly parentless — removes the last code path that could make it hide behind the app window." },
      { category: "Fix", text: "Export EQX File: after files are written a confirmation box lists every filename and the folder they were saved to — impossible to miss." },
    ],
  },
  {
    version: "1.1.018",
    date: "17 Jun 2026",
    items: [
      { category: "Fix", text: "Export API Calls: the CSV is now saved to your Downloads folder and File Explorer opens with the file highlighted — no app has to be installed and nothing can open behind another window." },
      { category: "Fix", text: "Export EQX File: the app now brings itself to the front before showing the folder picker, so the dialog always appears on the same monitor as the app." },
      { category: "Fix", text: "All IPC-side export log entries now appear in the same equinox-debug.log file for easier diagnosis." },
    ],
  },
  {
    version: "1.1.017",
    date: "17 Jun 2026",
    items: [
      { category: "Fix", text: "Export EQX File: the folder picker dialog now opens as a top-level window (no longer a child of the main window) so it always appears in front and cannot be hidden behind the app." },
    ],
  },
  {
    version: "1.1.016",
    date: "17 Jun 2026",
    items: [
      { category: "Fix", text: "Export API Calls: removed the save dialog entirely — the CSV is now written to a temp file and opened directly in Excel (or your default spreadsheet app) with no dialog to dismiss and no dialog that can open behind the main window." },
      { category: "Fix", text: "Export EQX File: removed the folder picker dialog — EQX files are now written directly to your Downloads folder with no dialog. A toast confirms exactly how many files were saved and the folder path." },
    ],
  },
  {
    version: "1.1.015",
    date: "17 Jun 2026",
    items: [
      { category: "Debug", text: "Export API Calls and Export EQX File: detailed step-by-step log entries are now written to Settings > Server Log for every export attempt — if either export fails, the exact failure point and error message will appear in the log so it can be diagnosed." },
    ],
  },
  {
    version: "1.1.014",
    date: "17 Jun 2026",
    items: [
      { category: "Analytics", text: "Evasion Stats: banned accounts are now split into three sub-populations — Never Ran (0 follows, banned at Verify), First Follow (1–9 follows, early ban), and Long Runners (10+ follows, sustained sessions). Select a group to see stats computed only for that population — averages are now meaningful instead of mixing three very different account types together." },
    ],
  },
  {
    version: "1.1.013",
    date: "17 Jun 2026",
    items: [
      { category: "UI", text: "Dashboard: page indicator is now a clickable dropdown — click it to jump directly to any page. Shows 'First (most recent)' and 'Last (oldest)' at the extremes, numbered pages in between. The dropdown shows 3 rows and scrolls." },
      { category: "UI", text: "Session Log (per account): same page-jump dropdown added — click the current page number to jump straight to any page." },
    ],
  },
  {
    version: "1.1.012",
    date: "17 Jun 2026",
    items: [
      { category: "UI", text: "Metrics tab: replaced the chaotic endpoint legend below the pie charts with a clean scrollable list on the left showing the top 10 endpoints with their percentage of the total." },
      { category: "UI", text: "Account Settings tab buttons (ACCOUNT SETTINGS, HUMAN SESSION TOOL, SESSION LOG, DASH, BROWSER, METRICS, COPY SETTINGS) are now a slightly darker cyan so they are clearly readable on a white background." },
      { category: "UI", text: "Human Session Tool: ORDER % and SKIP CHANCE % fields are now right-aligned in all sections." },
      { category: "UI", text: "Follow Tool, Unfollow Tool, and Contact Tool headers: ORDER % and SKIP CHANCE % fields are now right-aligned to match the Human Session Tool." },
    ],
  },
  {
    version: "1.1.011",
    date: "17 Jun 2026",
    items: [
      { category: "Fix", text: "Export EQX File: the folder picker dialog now opens as a standalone window instead of a child of the main window — on Windows, child dialogs can get stuck behind the main window making it look like nothing happened." },
      { category: "Fix", text: "Export API Calls: the CSV is now saved to a temp file and opened directly in Excel (or your default CSV app) with no save dialog needed." },
      { category: "Fix", text: "Both export actions now write detailed log entries to Settings > Server Log so any failure will show an exact error message instead of silently doing nothing." },
    ],
  },
  {
    version: "1.1.009",
    date: "17 Jun 2026",
    items: [
      { category: "Improvement", text: "Evasion Stats: added three new detection theory cards — Total API Call Rate Too High, Below Survivor Warmup Threshold, and No Burst-Idle Session Rhythm — derived from cross-proxy survivor analysis." },
    ],
  },
  {
    version: "1.1.008",
    date: "17 Jun 2026",
    items: [
      { category: "Improvement", text: "Statistics: the two pie charts on the Metrics tab now show a full endpoint breakdown (ViewTimelineFeedSeen, FollowedUser, GetDirectMessages, etc.) instead of just the 6 direct action types — every API call the account makes is now visible." },
      { category: "Fix", text: "Human Session — Repost: removed the yellow warning banner that appeared when skip chance was set to 100%." },
    ],
  },
  {
    version: "1.1.007",
    date: "17 Jun 2026",
    items: [
      { category: "Fix", text: "Export API Calls: removed the Save dialog entirely — the CSV now opens directly in your default spreadsheet app the same way Export Profiles does, with no dialog to dismiss." },
      { category: "Fix", text: "Export EQX File: removed the folder picker dialog — EQX files are now written directly to your Downloads folder with no dialog. A toast confirms how many files were saved and where." },
    ],
  },
  {
    version: "1.1.006",
    date: "17 Jun 2026",
    items: [
      { category: "Fix", text: "Export API Calls: a toast now appears the moment the save dialog opens so you know to look for a file picker window — previously it opened silently and looked like nothing happened." },
      { category: "Fix", text: "Export API Calls: if you close the save dialog without saving, a toast now says 'Export cancelled' instead of doing nothing." },
      { category: "Fix", text: "Export EQX File: a toast now appears when the folder picker opens, and cancelling now shows 'Export cancelled' instead of silently stopping." },
    ],
  },
  {
    version: "1.1.005",
    date: "17 Jun 2026",
    items: [
      { category: "Fix", text: "Export API Calls now shows a Save As dialog so you can choose exactly where the CSV is saved — previously it silently failed on systems where no default CSV application was registered, showing 'Export failed' with no way to diagnose it." },
      { category: "Fix", text: "Export API Calls now shows a spinner while the data is being fetched, and reports the exact error message if the server returns a failure instead of just 'Export failed'." },
      { category: "Fix", text: "Export EQX File: the entire export flow is now wrapped in error handling — any failure (folder picker error, network error, file write error) now shows a clear error toast instead of silently doing nothing." },
      { category: "Fix", text: "Export EQX File: individual account fetch failures now include the server error detail in the toast message so you can see exactly which accounts failed and why." },
      { category: "Fix", text: "Export EQX File: the button now shows a spinner while the export is in progress and is disabled to prevent double-clicks." },
    ],
  },
  {
    version: "1.1.001",
    date: "16 Jun 2026",
    items: [
      { category: "Fix", text: "Reassigning a proxy to an account now takes effect immediately — the automation engine detects the proxy change and recreates the internal API client on the fly, so you no longer need to reset device IDs to pick up the new proxy." },
      { category: "Fix", text: "Statistics page Proxy IP column now correctly shows the proxy for accounts linked via the Proxy Manager (previously only accounts with a manually typed proxy host showed a value; all others showed a dash)." },
      { category: "Improved", text: "Statistics page Proxy IP column header is now clickable to sort accounts by proxy host, the same as other columns." },
      { category: "Fix", text: "Add Account input box now has a white background and black text so it is clearly readable." },
      { category: "Fix", text: "Export Profiles CSV now correctly includes the proxy address for accounts linked via the Proxy Manager." },
      { category: "Fix", text: "Top activity bar no longer collapses or disappears on startup — it is always visible and shows 'Equinox started — no recent activity' until the first automation event arrives." },
    ],
  },
  {
    version: "1.1.000",
    date: "16 Jun 2026",
    items: [
      { category: "Security", text: "Accounts without a proxy can no longer open the embedded browser or make any API call — the block is now enforced at every layer (route, WebSocket upgrade, and inside the browser engine itself) so there is no path that can reach Instagram using your home IP." },
    ],
  },
  {
    version: "1.0.999",
    date: "16 Jun 2026",
    items: [
      { category: "Fix", text: "Verify no longer stalls or fails to mark accounts as valid after the verify sequence was trimmed — a missing internal counter declaration (removed alongside the trimmed phases) was causing a crash at the end of the session check." },
    ],
  },
  {
    version: "1.0.998",
    date: "16 Jun 2026",
    items: [
      { category: "Optimisation", text: "Verify sequence now uses a minimal suspicion-budget footprint: GetTimelineFeed, GetReelsTray, ExecuteNotificationsBadge, and TopicalExplore have been removed from the verify call chain. Only lightweight config probes remain (FetchConfig, GetBanyan) — no content reads burned on login." },
    ],
  },
  {
    version: "1.0.997",
    date: "16 Jun 2026",
    items: [
      { category: "Fix", text: "Evasion Stats: the Pre-[ErrorType] Endpoint Risk Ranking table is now on the Data tab of each error tab, not the Theories tab. It shows up to 15 endpoints ranked by their presence rate in the final 20 calls before each error event." },
    ],
  },
  {
    version: "1.0.996",
    date: "16 Jun 2026",
    items: [
      { category: "Fix", text: "Evasion Stats: the ranked endpoint table is now visible directly inside the Pre-[ErrorType] Endpoint Risk Pattern theory card on each error tab — showing each endpoint, its category, account count, and pre-event percentage." },
    ],
  },
  {
    version: "1.0.995",
    date: "16 Jun 2026",
    items: [
      { category: "UI", text: "Evasion Stats: Endpoint Risk is no longer a standalone tab. It is now a theory card inside each of the four error tabs (Banned, Automated, Captcha, Locked), showing the pre-event endpoint pattern specific to that error type — pre-ban for Banned, pre-captcha for Captcha, etc." },
      { category: "New", text: "Evasion Stats: each error tab's Theories section now shows a Pre-[ErrorType] Endpoint Risk Pattern card with a likelihood percentage bar, evidence text naming the top 3 endpoints and their account-presence rates, and action advice." },
    ],
  },
  {
    version: "1.0.993",
    date: "16 Jun 2026",
    items: [
      { category: "New", text: "Evasion Stats: new Endpoint Risk tab — data-driven table showing which API endpoints appear most in the final 20 calls before each ban/automated/captcha/locked event. Ranked by pre-ban presence %, with HIGH/MED/LOW risk labels and a TopicalExplore callout." },
      { category: "New", text: "Account Manager: new Verify Health column (turn on via Manage Columns) shows CLEAN (green) when an account's verify used only the core 10 ops, or +N (amber) when extra operations were triggered beyond the baseline." },
    ],
  },
  {
    version: "1.0.985",
    date: "16 Jun 2026",
    items: [
      { category: "UI", text: "Account Settings: tab labels (ACCOUNT SETTINGS, HUMAN SESSION TOOL, SESSION LOG, DASH, BROWSER, COPY SETTINGS) updated to brighter cyan." },
      { category: "New", text: "Account Settings: new METRICS button added between BROWSER and COPY SETTINGS — takes you directly to the Metrics page." },
      { category: "UI", text: "Account Settings: Verify Account button and Fire Random Endpoints at Login are now on the same row." },
      { category: "UI", text: "Account Settings: Proxy Settings moved below the Verify button row instead of alongside API Limits." },
      { category: "Fix", text: "Human Session Tool: each tool group is now correctly full width again — only the cyan title bar is capped at 50% width." },
    ],
  },
  {
    version: "1.0.984",
    date: "16 Jun 2026",
    items: [
      { category: "Fix", text: "Evasion Stats: build error in the Survivors tab fixed — the page now compiles and loads correctly." },
    ],
  },
  {
    version: "1.0.983",
    date: "16 Jun 2026",
    items: [
      { category: "Fix", text: "Accounts page: clicking the Verify button next to an account name no longer accidentally ticks that account's checkbox." },
      { category: "Fix", text: "Embedded browser login: pressing Tab after filling the password now flushes all keystrokes before the login button is clicked, preventing the last character from landing in the wrong position." },
      { category: "Fix", text: "Bulk Verify (Actions → Verify Selected): now uses the same logic as the individual Verify button — accounts that get a sessionid cookie even after a redirect or challenge now correctly proceed to the mobile API check instead of being marked as failed." },
      { category: "UI", text: "Evasion Stats: Theories moved inside each error tab (Banned, Automated, Captcha, Locked) as a dedicated sub-tab. Each theory's progress bar now shows the likelihood computed from that specific error type's accounts only, not combined across all error types." },
    ],
  },
  {
    version: "1.0.982",
    date: "16 Jun 2026",
    items: [
      { category: "Fix", text: "Sidebar: 'EVASION' label no longer hyphen-breaks across two lines — the word now always renders as one." },
      { category: "UI", text: "Human Session Tool: all sub-tool group boxes (Emulation, Follow, Unfollow, Contact) now display at 50% width instead of full page width." },
      { category: "UI", text: "Human Session Tool: 'Scheduled for:' now shows the time first then the date (e.g. 14:30:00, 16 Jun)." },
      { category: "New", text: "Open Instagram Calls: Fire Chance % min/max inputs added — set to 10–15% to fire these calls only that fraction of the time the Human Session runs." },
      { category: "UI", text: "Make a Post (Repost): tool renamed to 'Make a Post'." },
      { category: "UI", text: "Make a Post: 'Posted Posts' button moved to the title row alongside the tool name." },
      { category: "UI", text: "Make a Post: Post Caption Text section moved to directly below the title row." },
      { category: "UI", text: "Make a Post: caption placeholder text updated to 'Type a caption or use a token'." },
      { category: "UI", text: "Make a Post: 'Disable this source' checkbox moved to sit next to the source label instead of being right-aligned; source settings now fully collapse when disabled." },
      { category: "UI", text: "Make a Post: 'Run Repost Now' button removed." },
    ],
  },
  {
    version: "1.0.990",
    date: "16 Jun 2026",
    items: [
      { category: "UI", text: "Account Settings: 'endpoints after login' checkbox label shortened and Min/Max fields moved inline on the same row — no more stacked labels above the inputs." },
      { category: "UI", text: "Account Settings: Chance of Making a Post and its Min%/Max% fields now sit on one single row instead of expanding onto a separate line." },
      { category: "New", text: "Copy Settings: Chance of Making a Post added as a separate copyable option under API & Performance." },
      { category: "Fix", text: "Copy Settings: selected settings checkboxes now reset to unchecked on every app restart (target accounts still remembered between opens)." },
    ],
  },
  {
    version: "1.0.989",
    date: "16 Jun 2026",
    items: [
      { category: "New", text: "Statistics page: Proxy IP column added — shows the proxy host assigned to each account, visible by default and toggleable/reorderable like all other columns." },
      { category: "Content", text: "Evasion Stats: Session Uniqueness Fingerprint theory updated with counter-evidence from latest dataset — accounts with highly diverse randomised session fingerprints (CoV 1.6-1.7, diversity 72-82%) were still banned within minutes on proxies with 4-5 flagged accounts already present, challenging session diversification as a primary prevention measure." },
    ],
  },
  {
    version: "1.0.987",
    date: "16 Jun 2026",
    items: [
      { category: "UI", text: "Account Settings: all tab labels (Account Settings, Human Session Tool, Session Log, Dash, Browser, Metrics, Copy Settings) are now bold." },
      { category: "UI", text: "Account Settings: Fire Random Endpoints at Login — Min/Max fields are now vertically centred in their row." },
      { category: "New", text: "Account Settings: added Chance of Making a Post option (Min % / Max % fields) inside Fire Random Endpoints at Login. When the chance is hit during a verify, it uses the Human Session Make a Post settings and inserts the action at a random position among the endpoint calls." },
      { category: "UI", text: "Metrics page: account name dropdown is now scrollable with a max height of 25 rows so large account lists are easier to navigate." },
      { category: "UI", text: "Evasion Stats: Data / Theories toggle tabs are now 50% larger for better visibility." },
      { category: "UI", text: "Evasion Stats: Proxy Risk Ranking and Concurrent Usage Alerts are now hidden when the Theories inner tab is active — they only appear in the Data view." },
      { category: "UI", text: "Evasion Stats: removed double-hyphen separators from all cause signal descriptions — text now reads as plain sentences." },
      { category: "Content", text: "Evasion Stats Theories: all theory descriptions now open with 'What is being theorised is...' framing to make clear these are data-derived hypotheses, not confirmed facts." },
      { category: "Content", text: "Evasion Stats Theories: all recommended actions now reference only patterns observable in the flagged dataset, removing any advice derived from external third-party testing." },
    ],
  },
  {
    version: "1.0.986",
    date: "16 Jun 2026",
    items: [
      { category: "New", text: "Evasion Stats Theories: added Session-to-Action Ratio theory — tracks two failure modes: over-camouflaged accounts (too many passive calls, almost no actions) and raw-spam accounts (all actions, no passive calls), which each trigger independent Instagram classifiers." },
      { category: "New", text: "Evasion Stats Theories: added Low Endpoint Diversity + High Follow Ratio theory — tracks accounts that repeated a small set of endpoints heavily while making a large fraction of them follow actions, the distinguishing pattern behind automated-behaviour detection." },
      { category: "Improvement", text: "Evasion Stats Theories: all theory cards now auto-sort from highest to lowest likelihood percentage as your data grows — most confirmed theories rise to the top automatically." },
      { category: "Fix", text: "Account Settings METRICS button now opens the Metrics page pre-selected to that specific account instead of always defaulting to the first account in the list." },
      { category: "Fix", text: "Stats page Metrics tab account dropdown is now sorted alphabetically." },
    ],
  },
  {
    version: "1.0.981",
    date: "16 Jun 2026",
    items: [
      { category: "UI", text: "Account Settings: Proxy Settings section moved to directly below the Verify button — easier to fill in before verifying." },
      { category: "UI", text: "Account Settings: Fire Random Endpoints at Login checkbox now sits to the right of the Verify button instead of below it." },
      { category: "UI", text: "Tab bar: new METRICS button added (between BROWSER and COPY SETTINGS) — opens the Stats page Metrics tab pre-selected to that account." },
      { category: "UI", text: "Tab bar: inactive tab text is now a brighter cyan for better readability." },
      { category: "UI", text: "Human Session Tool: 'Exec Order' renamed to 'Order %' — inputs now capped at 0–100 to make priority percentage-based." },
    ],
  },
  {
    version: "1.0.980",
    date: "16 Jun 2026",
    items: [
      { category: "Fix", text: "Statistics page no longer crashes with 'Bot is not defined' — missing icon import added." },
      { category: "Fix", text: "Fire Random Endpoints: replaced GetActivityFeed (returned 404) with GetAccountSecurityInfo, a confirmed real endpoint." },
      { category: "Fix", text: "Fire Random Endpoints: fixed 3 other endpoints that were returning 404 (AttributionLaunch, BatchFetchWeb, GetSavedMedia had wrong URLs)." },
      { category: "Fix", text: "Fire Random Endpoints: fixed GetDirectMessages which would crash due to a non-existent method — replaced with GetPendingInbox." },
      { category: "Fix", text: "Fire Random Endpoints: removed 3 duplicate endpoint pairs (hitting the same URL twice) — replaced with distinct real endpoints." },
      { category: "Fix", text: "API call log: ViewUserFeed no longer appears as a raw numeric user ID — URL-to-name mapper now correctly maps /feed/user/{id}/ to ViewUserFeed." },
    ],
  },
  {
    version: "1.0.978",
    date: "15 Jun 2026",
    items: [
      { category: "New", text: "Copy Settings: 'Fire Random Endpoints at Login' is now a standalone copy option — copies only the enabled state and min/max count, merging into each target's existing API limits without touching their rate settings." },
    ],
  },
  {
    version: "1.1.004",
    date: "17 Jun 2026",
    items: [
      { category: "Fix", text: "Copy Settings → API Controls: after copying, the target account's settings page now immediately shows the new values — previously the per-account cache was not invalidated so you had to restart the app to see the change." },
      { category: "Fix", text: "Copy Settings: if the copy fails for any reason, a red error toast now appears with the reason — previously the dialog silently reset with no feedback." },
      { category: "Fix", text: "Copy Settings server: any error during the bulk write is now logged to the server log and the error detail is returned in the response so the toast can show it." },
    ],
  },
  {
    version: "1.1.003",
    date: "17 Jun 2026",
    items: [
      { category: "Fix", text: "Export API Calls: fixed a crash where any field containing a non-string value (e.g. a numeric message code) caused the CSV escape function to throw — all fields are now safely cast to string before escaping." },
      { category: "Fix", text: "Export API Calls: the server now logs the actual error to the server log file when the export fails, making it diagnosable from Settings > Server Log." },
      { category: "Fix", text: "API call history prune: fixed wrong SQL column name in the per-profile partition — was using the JavaScript property name instead of the database column name, so the prune silently did nothing every 50 inserts." },
    ],
  },
  {
    version: "1.1.002",
    date: "17 Jun 2026",
    items: [
      { category: "Fix", text: "Verify sequence now respects your API Control delay setting for every single call — previously the delay only applied to the random endpoint pool (Phase 2d), so tokens/keyed, launcher/sync, get_account_family, ABD probe, FetchConfig, and Banyan all fired at raw network speed with no spacing." },
      { category: "Fix", text: "Verify call order is now partially randomised — FetchConfig and Banyan fire in a random order each session instead of always FetchConfig-then-Banyan, reducing the identical session fingerprint across accounts on the same proxy." },
      { category: "Fix", text: "Export API Calls: date field is now null-safe — rows with a missing or malformed date no longer crash the export." },
    ],
  },
  {
    version: "1.0.977",
    date: "15 Jun 2026",
    items: [
      { category: "New", text: "Ban Analytics: added Session Uniqueness Fingerprint theory card — tracks how many flagged accounts share a /24 subnet, highlighting the risk of identical cold-start call sequences across accounts on the same IP." },
      { category: "New", text: "Account Settings: added 'Fire Random Endpoints at Login' checkbox with Min/Max fields — when enabled, a random selection of extra API calls is fired after each login to make every session's call fingerprint unique." },
      { category: "Fix", text: "Test Timing button now shows the full min–max range of per-call delay instead of a single random sample, so the result is always meaningful regardless of how your settings are configured." },
    ],
  },
  {
    version: "1.0.976",
    date: "15 Jun 2026",
    items: [
      { category: "Fix", text: "When a cooldown timer expires on a resuming account, the active toggle now automatically flips back on without needing a manual refresh." },
    ],
  },
  {
    version: "1.0.975",
    date: "15 Jun 2026",
    items: [
      { category: "Fix", text: "Logged Out status pill in account settings now shows the same yellow colour as on the accounts page." },
      { category: "Fix", text: "Evasion Stats page no longer crashes with 'warmupList is not defined' when opened." },
    ],
  },
  {
    version: "1.0.974",
    date: "15 Jun 2026",
    items: [
      { category: "Fix", text: "Human Session tool: fixed all settings fields not accepting input — settings state now has correct type for dynamic key access, missing defaults for Reel Watch % and Repost Count fields added, and settings re-sync from server on tab re-open." },
      { category: "Fix", text: "Login rate limit warning no longer fires on failed verification attempts — the IP event is only recorded when verification actually succeeds." },
      { category: "Fix", text: "Embedded browser password entry no longer scrambles characters — switched to direct value injection bypassing Android IME simulation." },
      { category: "Fix", text: "FetchConfig (qe/sync) 400 error on verification resolved — request now sends only the required fields without the outdated experiments list." },
    ],
  },
  {
    version: "1.0.973",
    date: "15 Jun 2026",
    items: [
      { category: "Fix", text: "Proxy Manager: deleting an account no longer deletes a manually-added proxy. Auto-cleanup only applies to proxies that were auto-created by the Link Proxies import flow." },
    ],
  },
  {
    version: "1.0.972",
    date: "15 Jun 2026",
    items: [
      { category: "Fix", text: "Proxy Manager: typing just an IP address in the proxy field (without :port) no longer resets the field to 0.0.0.0:8080 when clicking Ping — the existing port is kept automatically." },
    ],
  },
  {
    version: "1.0.971",
    date: "15 Jun 2026",
    items: [
      { category: "Fix", text: "Evasion Stats: follow call density metric now measures the average number of API calls already logged before each individual follow call in the session, averaged across all follows. Sessions with no follow calls show — instead of a count." },
      { category: "Fix", text: "The 'Follow Call Density' theory card now describes exactly what is measured with no causal claims — it is a factual log count, not a safety indicator." },
      { category: "Fix", text: "FOLLOW EARLY badge now appears on event cards where the average position of follow calls was fewer than 3 calls into the session." },
    ],
  },
  {
    version: "1.0.970",
    date: "15 Jun 2026",
    items: [
      { category: "Fix", text: "Evasion Stats: removed all 'warmup calls' language — no call category can be claimed as safe or warmup. The metric is now labelled 'Calls before first action' everywhere and shows the raw count with no interpretation." },
      { category: "Fix", text: "The 'Minimum Warmup Gate' theory card has been rewritten as 'Action-First Sessions' — it now describes what the log shows factually rather than claiming Instagram expects warmup behaviour." },
      { category: "Fix", text: "Survivor vs Flagged comparison: 'Warmup calls' row no longer implies higher is better — it is a neutral count of calls logged before the first action endpoint." },
    ],
  },
  {
    version: "1.0.969",
    date: "15 Jun 2026",
    items: [
      { category: "New", text: "Evasion Stats Survivors tab: now shows live call patterns for every surviving account — warmup count, session-to-action ratio, follow count, timing CoV, action velocity, and top 3 endpoints pulled directly from the API call log." },
      { category: "New", text: "Evasion Stats Survivors tab: comparison panel shows the average warmup calls, session ratio, follow count, timing CoV, and total calls for surviving accounts side by side against the average for flagged accounts, so you can see exactly what the survivors are doing differently." },
    ],
  },
  {
    version: "1.0.968",
    date: "15 Jun 2026",
    items: [
      { category: "New", text: "Evasion Stats: 7 new diagnostic fields are now captured at the moment any account is flagged — account age in days, verify operations in the last 24 hours, number of other accounts on the same proxy, follow count, session-to-action ratio, session time span, and last operation before the flag." },
      { category: "New", text: "Evasion Stats export: computed metrics (timing CoV, call velocity, Shannon entropy, anomaly score, burst count, top 10 endpoints) are now included per entry in the JSON file so future analysis has all the numbers ready without re-computing them." },
      { category: "New", text: "Evasion Stats Theories tab: added New Account Trust Ramp theory — tracks the percentage of bans on accounts under 7 days old that had at least one follow operation, the primary pattern behind confirm-you-are-human bans." },
    ],
  },
  {
    version: "1.0.967",
    date: "15 Jun 2026",
    items: [
      { category: "New", text: "Theories tab: added Concurrent Endpoint Monotony theory — repeating the same endpoint (e.g. follow → follow → follow) without mixing in passive actions is believed to be a stronger bot signal than a mixed session." },
      { category: "Fix", text: "Logged Out status pill is now amber (same style as Resuming) instead of a solid red fill." },
      { category: "Fix", text: "Verify Delay Mode in Settings: the inactive mode's delay settings are now greyed out so it's obvious which one is active." },
      { category: "Fix", text: "Account Settings tab buttons (ACCOUNTS, SETTINGS, HUMAN SESSION, etc.) now use the cyan accent colour used elsewhere in the app instead of blue." },
      { category: "Fix", text: "Account Settings: Proxy Settings and API Limits controls are now shown side by side in a two-column layout." },
      { category: "Fix", text: "Account Settings: Profile Sync section now has a gap below its divider line." },
      { category: "Fix", text: "Account Settings: cookie injection description reworded to one short line." },
      { category: "Fix", text: "Account Settings: API User Agent picker text now uses the same size font as the Embedded Browser Agent field." },
      { category: "Fix", text: "Statistics page: Human Session column now uses the fingerprint icon instead of the robot icon." },
    ],
  },
  {
    version: "1.0.966",
    date: "15 Jun 2026",
    items: [
      { category: "New", text: "IP Login Rate Limit warning: clicking Verify or Login on an account whose proxy was used for a login within the last 90 minutes now shows a warning dialog with the time elapsed and the safe retry window before you proceed." },
      { category: "New", text: "Import EQX: the account's Notes section now automatically records a 'Re-imported' timestamp each time you import the file, so the Longest Survivors tab always reflects the true in-use date for re-added accounts." },
    ],
  },
  {
    version: "1.0.965",
    date: "14 Jun 2026",
    items: [
      { category: "New", text: "Evasion Stats Theories: added IP Login Rate Limit theory — Instagram appears to limit how many browser + API login pairs an IP can perform per hour. Each verify = 2 logins. Theory threshold: ~1–2 verifies per 90 min per IP. The likelihood bar is computed live from your flagged accounts that were banned with zero tool activity." },
    ],
  },
  {
    version: "1.0.964",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "Verify: browser window no longer flashes in the centre of the screen before moving to the corner — position is now locked from creation." },
      { category: "Fix", text: "Verify: accounts that show 'Confirm you're human' in the browser now correctly display as Confirm Human, not Auto Behav — the two statuses look similar to Instagram but mean different things to you." },
    ],
  },
  {
    version: "1.0.963",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "Verify: mobile API calls now run even when Instagram redirects through a suspended/human-check page after login — the browser login sets the sessionid cookie, which is all the mobile API needs. The mobile API is now the authoritative pass/fail judge, not the browser URL." },
      { category: "Fix", text: "Verify: fixed a crash ('No values to set') that was resetting status back to pending after a ban/suspended result — the account card now correctly shows the final status." },
    ],
  },
  {
    version: "1.0.962",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "Verify: browser now opens as a small window in the bottom-right corner instead of minimised — Chromium throttles minimised windows causing the password to be typed into the username field. Corner window is visible so timing is accurate." },
      { category: "Fix", text: "Verify: window no longer steals focus from whatever you are working in — it appears inactive in the corner." },
      { category: "Fix", text: "Verify: Reset Device IDs and Wipe now clear the in-flight verify lock — previously the app got stuck spinning after a reset because the old lock was never released." },
    ],
  },
  {
    version: "1.0.961",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "Verify: fixed the root cause of cookies never being harvested — the auto-fill from the browser window was racing with the verify auto-fill and both were failing silently. Only one fill now runs." },
      { category: "Fix", text: "Verify: added step-by-step debug logging across the full verify flow so failures are visible in the log file." },
    ],
  },
  {
    version: "1.0.960",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "Verify: clicking Verify now automatically opens the browser so you can watch the login flow, and closes it automatically once cookies are captured." },
      { category: "Fix", text: "Verify: cookies are now correctly harvested from the active Instagram tab — previously the automation was running against the toolbar frame instead of the page." },
      { category: "Fix", text: "Verify: when no browser was open, the fallback login window is now visible instead of hidden — so nothing appears to happen no more." },
    ],
  },
  {
    version: "1.0.959",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "Auto-login: 2FA fallback keyboard sequence corrected to Tab Tab Tab Enter — the extra Tab skips past the 'Trust this device' checkbox to land on the Continue button." },
    ],
  },
  {
    version: "1.0.958",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "Auto-login: 2FA code field is now found reliably — added the placeholder-based selector that Instagram's current login page uses. TOTP code is auto-filled and Continue is clicked via JS. Post-2FA navigation now waits for the home page instead of resolving instantly." },
    ],
  },
  {
    version: "1.0.957",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "Auto-login: login form now submits via a direct JS click on the button instead of Tab Tab Enter — fixes the stall caused by focus landing on the password-visibility eye icon instead of the Login button." },
    ],
  },
  {
    version: "1.0.956",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "Auto-login: after the password is typed, now presses Tab Tab Enter to move focus to the Login button and submit the form — previously nothing happened after the password was filled." },
    ],
  },
  {
    version: "1.0.955",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "Auto-login: now presses Tab twice after typing the username to correctly land focus on the password field — one Tab was landing on an intermediate element and still causing the password to overwrite the username." },
    ],
  },
  {
    version: "1.0.954",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "Auto-login: now presses Tab after typing the username so focus moves to the password field — previously the password was being typed back into the username field, overwriting it." },
    ],
  },
  {
    version: "1.0.953",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "Verify button: stuck 'already in progress' lock now auto-clears after 10 minutes — previously a crashed background verify permanently blocked re-verify until the app was restarted." },
      { category: "Fix", text: "Verify button: if the background verify crashes unexpectedly, the account status now resets to 'pending' instead of getting stuck on 'verifying' forever." },
    ],
  },
  {
    version: "1.0.952",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "Verify button: no longer flashes and resets — the 'verifying' state now sticks immediately when clicked and stays until the background check completes." },
      { category: "Fix", text: "Verify button: toast now correctly says 'Verification started' instead of the misleading 'Verified' that fired before the check had actually finished." },
      { category: "Fix", text: "Login button macro: username field is now reliably focused before typing, fixing the bug where it typed nothing into the username field and instead went Tab Tab Tab Tab then only filled the password." },
    ],
  },
  {
    version: "1.0.951",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "Verify button: if the EB browser is already open for that account, the verify now runs visibly inside it so you can watch the flow — instead of silently in a hidden background window." },
      { category: "Fix", text: "Verify button: same fix applies to the big Verify button inside Account Settings." },
    ],
  },
  {
    version: "1.0.950",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "2FA button: TAB TAB now runs first (before finding the code field), so focus is in the right place before the automation fills and submits the code." },
    ],
  },
  {
    version: "1.0.949",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "Settings: Min and Max delay inputs now sit side-by-side on the same row in both delay cards." },
      { category: "Fix", text: "Verify button: silent login now sends TAB TAB after dismissing the cookie banner, matching the manual Login button flow." },
      { category: "Fix", text: "Verify button: 2FA auto-fill now sends TAB TAB after typing the code, ensuring the submit button activates before it is clicked." },
      { category: "Fix", text: "2FA button: TAB TAB added after typing the TOTP code so the submit button is active before being clicked." },
    ],
  },
  {
    version: "1.0.992",
    date: "16 Jun 2026",
    items: [
      { category: "Fix", text: "Statistics page: fixed crash caused by missing Globe icon import — page now loads correctly." },
      { category: "Fix", text: "Single instance: opening Equinox a second time now focuses the existing window instead of launching a second copy." },
      { category: "Fix", text: "Account Settings: 'endpoints after login' label renamed to 'Fire Unique Endpoints on Login'." },
      { category: "Fix", text: "Account Settings: 'Chance of Making a Post' is now on the same row as 'Fire Unique Endpoints on Login' — nothing stacked below." },
    ],
  },
  {
    version: "1.0.991",
    date: "16 Jun 2026",
    items: [
      { category: "Fix", text: "Statistics page: no longer crashes when the Proxy IP column is present in the column order." },
      { category: "Fix", text: "Evasion Stats export: verify count per account now correctly counts successful verifies (browser + API both confirmed) instead of counting individual API calls within a verify session." },
      { category: "Fix", text: "Evasion Stats export: added verify timeline section showing how many accounts verified through each proxy per day." },
      { category: "Fix", text: "Proxy pause on ban: accounts using a direct proxy host (without a proxy ID) are now correctly paused when a sibling account is banned on the same proxy." },
    ],
  },
  {
    version: "1.0.948",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "Settings: Both verify delay cards are now always editable — selecting a mode determines which values are used, not which inputs you can touch." },
    ],
  },
  {
    version: "1.0.947",
    date: "14 Jun 2026",
    items: [
      { category: "New", text: "Settings: Verify All Accounts Delay now uses minutes and seconds instead of seconds only." },
      { category: "New", text: "Settings: Added 'Verify Accounts Sharing the Same Proxy' delay — accounts on the same proxy are staggered by this amount while accounts on different proxies verify simultaneously." },
      { category: "New", text: "Settings: The two verify delay modes are mutually exclusive — only one can be active at a time." },
      { category: "Fix", text: "Login button: Two Tab keypresses are now sent after the cookie banner is dismissed and before the username field is filled, matching manual login behaviour." },
    ],
  },
  {
    version: "1.0.946",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser: text input now simulates Android on-screen keyboard exactly — each character fires keyCode 229 (VK_PROCESSKEY) with human inter-key delays, matching how a real Android IME fires events rather than sending desktop key codes or clipboard paste." },
    ],
  },
  {
    version: "1.0.945",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser: Nuke Environment now fully clears the previous session — stale Instagram cookies are no longer carried over into the next signup attempt." },
    ],
  },
  {
    version: "1.0.944",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "Evasion Stats: Scan with AI removed from the Theories tab — it required an API key that frequently hit quota limits." },
      { category: "Fix", text: "Accounts: When a ban is detected, accounts on the same proxy are paused silently — no 'Proxy taint' message is written to their notes any more." },
      { category: "Fix", text: "Ghost Browser: Text entry now uses clipboard-style insertion (same as pasting on Android) instead of simulated keyboard typing, which was detectable by Instagram's input-timing classifier." },
    ],
  },
  {
    version: "1.0.941",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "Accounts: Sync and Last API Call column text is now full black instead of grey — easier to read at a glance." },
      { category: "Improvement", text: "Evasion Stats: Verify-only ban detection now also catches accounts where the EB login (browser phase) was the only activity — not just API Verify calls." },
      { category: "New", text: "Evasion Stats: Verify Cluster Fingerprint added as a hardcoded theory — detects when multiple accounts were verified on the same proxy within 30 minutes of each other, which is a high-signal bot cluster pattern." },
      { category: "New", text: "Evasion Stats: Scan with AI button on the Theories tab sends your ban data summary to Equinox AI to find patterns beyond the 6 built-in theories (requires OpenAI key in Settings)." },
      { category: "Fix", text: "Proxy Manager: IP:port, username, and password input text is now full black instead of grey." },
    ],
  },
  {
    version: "1.0.940",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "Accounts: IP:PORT column font is now the same size and weight as the username column — easier to read." },
      { category: "Fix", text: "Accounts: IP:PORT column sort now correctly orders accounts that use a linked proxy (not just inline proxies)." },
      { category: "Improvement", text: "Evasion Stats: EB login events are now tracked as API calls so they show up in the endpoint log and stats." },
      { category: "New", text: "Evasion Stats: new Live IP Occupancy panel shows how many accounts are on each proxy right now, how long they've been on it, and how long they've been sharing it." },
    ],
  },
  {
    version: "1.0.939",
    date: "14 Jun 2026",
    items: [
      { category: "Removed", text: "AI Studio tab removed." },
    ],
  },
  {
    version: "1.0.938",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "AI Studio: generation now routes through the local server instead of directly to Pollinations — this fixes the 'model unavailable' error caused by Pollinations rate-limiting direct browser requests." },
      { category: "Fix", text: "AI Studio: server automatically retries up to 8 times when Pollinations is busy (rate limit = 1 request queued per IP), so you no longer have to manually retry." },
    ],
  },
  {
    version: "1.0.937",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "AI Studio: reference image upload now fully works — pick any image from your PC, it uploads automatically, and is used as a reference when you generate." },
      { category: "Improvement", text: "AI Studio: Generate button shows 'Generate with Reference' when a reference image is active, and stays disabled while the upload is in progress." },
    ],
  },
  {
    version: "1.0.936",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "AI Studio: model dropdown now shows 13 confirmed working models (Flux, Turbo, Flux Realism, Flux Dev, Flux Pro, Flux Anime, Flux 3D, Any Dark, GPT Image, DALL-E 3, Stable Diffusion, Playground v2.5, Sana) instead of only showing 'sana'." },
      { category: "New", text: "AI Studio: added Reference Image section — paste a public image URL to use as a style/content reference for generation (img2img)." },
      { category: "New", text: "AI Studio: added local reference image upload — pick any image from your PC to display as visual inspiration while you write your prompt." },
    ],
  },
  {
    version: "1.0.935",
    date: "14 Jun 2026",
    items: [
      { category: "Improvement", text: "AI Studio: model list now fetched live from Pollinations on every open — always shows all currently available models without needing an app update." },
      { category: "Improvement", text: "AI Studio: added custom model name input — type any model name you find on pollinations.ai and it will be used directly." },
      { category: "Improvement", text: "AI Studio: added HD and HD Wide size options (768×1024 and 1024×768)." },
    ],
  },
  {
    version: "1.0.934",
    date: "14 Jun 2026",
    items: [
      { category: "New", text: "AI Studio tab re-added — now powered by Pollinations AI, no setup required, works instantly. Type a prompt and generate images including NSFW with a toggle." },
      { category: "New", text: "AI Studio: choose from 6 models (Flux, Flux Realism, Flux Anime, Flux 3D, Any Dark, Turbo), pick size, toggle NSFW and prompt enhancement, re-roll with a new seed, and save to PC." },
    ],
  },
  {
    version: "1.0.933",
    date: "14 Jun 2026",
    items: [
      { category: "Removed", text: "AI Studio tab removed — required too much manual setup (Python, Git, Stable Diffusion) to be useful." },
    ],
  },
  {
    version: "1.0.930",
    date: "14 Jun 2026",
    items: [
      { category: "New", text: "AI Studio tab added — connect to a locally running Stable Diffusion (Forge/A1111) instance and generate images directly inside Equinox with no content restrictions." },
      { category: "New", text: "AI Studio: type a prompt, pick a size, adjust steps and CFG scale, then generate and save images to your PC in one click." },
      { category: "New", text: "AI Studio: built-in 3-step setup guide for installing Stable Diffusion Forge on Windows with the right models for your hardware." },
      { category: "Improvement", text: "Auto-ban detection now fires the full ban pipeline (API call snapshot, ban analytics, proxy taint pause) automatically when an account is detected as banned during Verify or a running automation — no manual flagging needed." },
    ],
  },
  {
    version: "1.0.929",
    date: "14 Jun 2026",
    items: [
      { category: "New", text: "Evasion Stats: added Theories tab — 6 detection theory cards (IP TrustScore Budget, Minimum Warmup Gate, Robotic Timing, Auth Overcalling, Velocity Cap, TrustScore Decay Chain) each with a live likelihood bar calculated from your flagged account data." },
      { category: "Improvement", text: "Evasion Stats: Proxy Risk Ranking and Concurrent Usage Alerts now collapse to 3 rows by default with a Show more / Show less toggle, keeping the page tidy when lists are long." },
      { category: "Fix", text: "Evasion Stats: Concurrent Usage Alerts now use the actual last API call timestamp from the session snapshot for timing comparisons, not the manual mark time — gives more accurate 30-minute proximity detection." },
      { category: "Fix", text: "Embedded Browser: new windows now use the available work area instead of maximize(), so the browser never covers the Windows taskbar." },
      { category: "Fix", text: "Embedded Browser: Login and 2FA autofill buttons now focus the correct field and add a short delay before filling, fixing a focus-steal issue caused by the toolbar stealing OS focus." },
    ],
  },
  {
    version: "1.0.928",
    date: "13 Jun 2026",
    items: [
      { category: "Fix", text: "Human Sessions Tool: section checkboxes now default to enabled so all fields are visible and editable out of the box — previously new accounts showed everything greyed out until each section was manually toggled on." },
      { category: "Fix", text: "Human Sessions Tool: fixed a tool-type mismatch that could cause the panel to show 'tool not found' for profiles created after a server update." },
      { category: "Fix", text: "Human Sessions Tool: added a stability fix so the panel correctly resets its settings when switching between accounts, preventing stale values from a previously viewed profile from appearing." },
    ],
  },
  {
    version: "1.0.927",
    date: "13 Jun 2026",
    items: [
      { category: "Fix", text: "Evasion Stats: HikerAPI calls are now excluded from endpoint counts and snapshots when an account is flagged — only calls the account made itself are counted." },
    ],
  },
  {
    version: "1.0.926",
    date: "13 Jun 2026",
    items: [
      { category: "New", text: "Evasion Stats: added an Export Evasion Stats button in the page header — downloads a full JSON snapshot of all flagged accounts, survivors, proxy risks, and trust score data." },
      { category: "Fix", text: "Copy Settings dialogs (Account Settings, Human Sessions, and all tools) now remember the previously selected accounts and settings across opens — selections were being silently wiped on every close." },
      { category: "New", text: "TrustScores page: added an info panel explaining that scores are sorted from 1 upwards and that higher numbers mean a better TrustScore." },
    ],
  },
  {
    version: "1.0.925",
    date: "13 Jun 2026",
    items: [
      { category: "Fix", text: "Evasion Stats: TrustScore data now correctly appears for flagged accounts — the lookup was silently failing due to a username-matching issue; it now uses the profile's ID directly." },
      { category: "Fix", text: "New accounts added to a proxy that is already in a ban countdown now automatically inherit the remaining pause time instead of starting active immediately." },
    ],
  },
  {
    version: "1.0.924",
    date: "13 Jun 2026",
    items: [
      { category: "Fix", text: "Adding multiple blank accounts at once now correctly creates a separate account for each slot — previously all slots were overwriting the same first blank account." },
      { category: "Fix", text: "Account Settings: removed the explanatory label below the Notes field." },
      { category: "Fix", text: "Account Settings: added a divider line below the Auto Sync section to visually separate it from the content beneath." },
      { category: "Fix", text: "Account Settings: Account Details heading now uses a person icon instead of a tag icon." },
      { category: "Fix", text: "Account Settings: Notes panel no longer stays pinned to the top while scrolling — it now scrolls naturally with the rest of the page." },
    ],
  },
  {
    version: "1.0.923",
    date: "13 Jun 2026",
    items: [
      { category: "Improved", text: "Evasion Stats: each error tab (Ban, Automated, Captcha, Locked) now shows a mathematical causation panel explaining exactly what causes that specific error type, with each theoretical signal validated against your actual data and shown as confirmed, partial, or not seen." },
      { category: "Improved", text: "Evasion Stats: TrustScore correlation panel added — shows the TrustScore distribution of flagged accounts vs surviving accounts, with automatic insight generation based on whether low-trust or high-trust accounts are being flagged." },
      { category: "Improved", text: "Evasion Stats: data reliability weighting added — accounts with 2+ re-adds in their notes are flagged as lower-confidence data points and shown with reliability badges on each entry card." },
      { category: "Improved", text: "Evasion Stats: each flagged event card now shows the account's current TrustScore rank badge and any re-add count warning inline." },
      { category: "Improved", text: "Survivors tab now displays TrustScore distribution for all surviving accounts — showing the rank tier breakdown that characterises accounts Instagram rewards." },
    ],
  },
  {
    version: "1.0.922",
    date: "13 Jun 2026",
    items: [
      { category: "Improved", text: "Evasion Stats analysis expanded with every measurable dimension: timing Coefficient of Variation (robotic vs human pacing), Shannon entropy (endpoint diversity), pre-action warmup depth, action velocity per hour, minimum/maximum inter-call gap, subnet-level (/24) concurrency grouping, time-of-day flag patterns, first/last endpoint sequence analysis, and full session call composition breakdown." },
      { category: "Improved", text: "Per-event anomaly scoring now factors in 7 dimensions: call rate, session noise, timing CoV, Shannon entropy, burst presence, warmup depth, and session span — each compared to the group median via z-score." },
    ],
  },
  {
    version: "1.0.921",
    date: "13 Jun 2026",
    items: [
      { category: "Fix", text: "Accounts flagged as Banned, Automated Behaviour, Captcha Error, or Locked — the 'Flag as' buttons in Actions now have no colour coding, matching the style of all other action buttons." },
      { category: "Fix", text: "Accounts in proxy-taint cooldown no longer show a Verify button next to their name — Verify implies logged out, which these accounts are not." },
      { category: "Fix", text: "Proxy-taint cooldown now toggles the Active switch OFF for sibling accounts (rather than setting a custom status), and auto-toggles it back ON when the 90-minute timer expires — no verify step involved." },
      { category: "Fix", text: "The Resuming countdown badge now shows correctly for accounts that are toggled off due to proxy taint — it appears inside the Stopped badge with a live timer." },
      { category: "Improved", text: "Evasion Stats completely rebuilt: all static theory text removed. The page now computes real mathematics from your actual API call data — mean/median/std dev of call rates and session noise ratios, distribution histograms, burst detection, common endpoint denominators, and data-derived anomaly scoring per event." },
    ],
  },
  {
    version: "1.0.920",
    date: "13 Jun 2026",
    items: [
      { category: "New", text: "When an account is flagged as banned, all other accounts on the same proxy are automatically paused for 90 minutes to protect them from the tainted IP — they show a live countdown in the status badge and restart their tools automatically when the cooldown expires." },
      { category: "Improved", text: "Account status pill now shows a live countdown timer when an account is in Resuming state, ticking down second-by-second until tools restart." },
      { category: "Improved", text: "Account Details header reordered: Trust Score badge now appears immediately after the status pill, before the account navigation arrows." },
    ],
  },
  {
    version: "1.0.919",
    date: "13 Jun 2026",
    items: [
      { category: "Improved", text: "Evasion Stats: removed the 4 summary blocks at the top — counts are already shown in the tab headers so they were redundant." },
      { category: "New", text: "Evasion Stats: replaced the Common Endpoints list with an Endpoint Ratio Analysis showing timeline, DM, like, follow, and auth call ratios vs healthy targets." },
      { category: "New", text: "Evasion Stats: each tab now shows a Logic & Reasoning panel explaining what triggers that specific flag type and how Instagram detects it." },
      { category: "Improved", text: "Evasion Stats: Event History now shows the 3 most recent entries by default with a 'Show all' button — prevents the page flooding when many events are recorded." },
      { category: "Improved", text: "Evasion Stats: Concurrent Usage Alerts moved below Proxy Risk Ranking." },
      { category: "Improved", text: "Evasion Stats: Proxy Risk Ranking no longer lists which accounts were on each proxy — that detail is available in each individual event entry." },
      { category: "New", text: "Account Settings: Notes field moved to the far right of the settings panel, visible at all times starting from the Group row — no longer buried inside the collapsed Account Details section." },
      { category: "New", text: "Account history is now auto-logged to Notes when an account is flagged as Banned, Automated Behaviour, Captcha Error, or Locked Account — each entry includes a date and UTC timestamp." },
      { category: "Fix", text: "Accounts page Actions menu: 'Flag as Automated Behaviour' text now stays on a single line and never wraps to two lines." },
    ],
  },
  {
    version: "1.0.918",
    date: "12 Jun 2026",
    items: [
      { category: "Fix", text: "Evasion Stats: page header icon now matches the magnifying glass shown in the sidebar nav — they were showing different icons before." },
      { category: "Improved", text: "Evasion Stats: proxy address in each log entry now appears on its own line below the @username instead of next to it on the same row." },
      { category: "New", text: "Evasion Stats: Proxy Risk Ranking rows now have a red × delete button (appears on hover) that removes all log entries for that proxy across all tabs at once." },
      { category: "Improved", text: "Proxy Manager: status ping result and accounts count are now centred in their columns instead of left-aligned. The status badge no longer stretches across the full column width." },
      { category: "Improved", text: "Proxy Manager: USERNAME and PASSWORD column headers are now centred within their column width." },
    ],
  },
  {
    version: "1.0.917",
    date: "12 Jun 2026",
    items: [
      { category: "Fix", text: "EQX and bulk imports now stamp a 'Re-imported' date and time in Account Settings → Notes every time an existing account is re-imported, so you have a full history of when each account was added." },
      { category: "New", text: "Evasion Stats: each log entry across all tabs now has a small red × button to delete it individually — useful for removing entries with missing data such as no proxy recorded." },
      { category: "Improved", text: "Evasion Stats: 'Top Surviving Accounts' moved to its own tab inside the main panel so it no longer crowds the page. Survival timer now resets on each re-import, showing only genuine long-running sessions." },
      { category: "Improved", text: "Evasion Stats: 'Ban Events' tab renamed to 'Banned Accounts'. Proxy Risk Ranking moved to the bottom of the page. All @usernames across the page are now clickable links to that account's settings." },
      { category: "Improved", text: "Account Settings: the Followers, Following, Posts stat cards and Last Synced timestamp are now on the same row as the Auto Sync controls instead of on a separate block below." },
    ],
  },
  {
    version: "1.0.916",
    date: "12 Jun 2026",
    items: [
      { category: "Fix", text: "Login button flow in the embedded browser now presses Tab, Tab, Enter after typing the password — matching the expected keyboard sequence and submitting the form directly without waiting for the button to become clickable." },
      { category: "Fix", text: "Copy Settings dialog now remembers which accounts were ticked, which settings were ticked, and the sort order you chose — all restored next time you open it. Only resets when the app restarts." },
      { category: "New", text: "Evasion Stats: new 'Top Surviving Accounts' section lists your valid accounts ranked by how long they've been running, sourced from the date stamp in Account Settings → Notes. Re-added accounts show a badge and the latest re-add date." },
    ],
  },
  {
    version: "1.0.915",
    date: "12 Jun 2026",
    items: [
      { category: "Improved", text: "Evasion Stats: removed severity labels (High/Medium/Low) — they were misleading and irrelevant. All flagged accounts show data only: call counts, rate, action totals, and endpoint breakdown." },
      { category: "Improved", text: "Evasion Stats: removed speculative findings. If there is not enough data to identify what happened, it now says that plainly instead of guessing." },
      { category: "Improved", text: "Evasion Stats: HikerAPI calls are now excluded from endpoint counts and top-endpoints lists — only Instagram session calls count toward the analysis." },
      { category: "Improved", text: "Evasion Stats: removed the three summary stat boxes (Events / API Calls / Unique Endpoints) — not useful at a glance. The expandable per-account cards now show all detail including follows, unfollows, DMs, likes, call rate, and full endpoint list." },
    ],
  },
  {
    version: "1.0.914",
    date: "12 Jun 2026",
    items: [
      { category: "Fix", text: "Flag as Banned no longer deletes the account — it now sets the status to Banned and keeps the account in Equinox so you can still access and recover it, matching the behaviour of all other flag actions." },
      { category: "Fix", text: "Proxy shown as 'no proxy' in Evasion Stats is fixed — all four flag actions now correctly resolve the proxy host from the Proxy Manager when the account uses a linked proxy rather than manual host settings." },
      { category: "Improved", text: "Evasion Stats completely overhauled: each flagged account now shows a smart diagnosis explaining why it was flagged — follow/DM/like call counts, API call rate, high-risk endpoint identification, and plain-English findings instead of raw endpoint lists." },
      { category: "Improved", text: "Evasion Stats: cross-account pattern analysis now highlights endpoints that appear in 50%+ of all flagged accounts, making it easy to spot which tool or behaviour is consistently triggering flags." },
    ],
  },
  {
    version: "1.0.913",
    date: "12 Jun 2026",
    items: [
      { category: "Feature", text: "Evasion Stats: new Locked Account tab tracks accounts flagged as locked, with proxy risk ranking and concurrency alerts." },
      { category: "Feature", text: "Account Actions: new 'Flag as Locked Account' option snapshots API calls and marks the account status as Locked." },
      { category: "Fix", text: "Login auto-fill now sends two Tab presses (username → checkbox → password) instead of one, matching Instagram's updated form layout." },
      { category: "Fix", text: "Wrong password no longer triggers a page-refresh loop — auto-fill is suppressed for 90 seconds after the first login attempt." },
      { category: "UI", text: "Actions menu reorganised: Export API Calls moved to the top row; EQX/Binary buttons grouped on their own row; Assign TrustScore on the same row as Group/Ungroup; Flag Accounts on the same row as Lock/Unlock." },
    ],
  },
  {
    version: "1.0.912",
    date: "12 Jun 2026",
    items: [
      { category: "Fix", text: "Clicking Verify now responds instantly regardless of how many other accounts are already being verified — the 3-account concurrent limit has been removed and the route no longer hangs waiting for a queue slot." },
      { category: "Fix", text: "Verify button moved to appear immediately after the account name instead of next to the status pill." },
      { category: "Fix", text: "Logged Out status pill is now red with white text so it stands out clearly from other statuses." },
      { category: "Fix", text: "Evasion Stats sidebar icon changed to a thick filled magnifying glass in cyan." },
      { category: "Fix", text: "Embedded browser window now uses maximize() on open so it reliably fills the full work area on all DPI and taskbar configurations." },
    ],
  },
  {
    version: "1.0.911",
    date: "12 Jun 2026",
    items: [
      { category: "Fix", text: "Evasion Stats sidebar icon updated to a spy figure with magnifying glass crosshairs for a more distinct malware-scanner look." },
      { category: "Fix", text: "Accounts page Select All / Select None / Actions toolbar is now pinned to the bottom of the window at all times, regardless of how many accounts are loaded." },
      { category: "Fix", text: "Metrics page: HS Cycles moved into the Action Totals group alongside Follow, Unfollow, DMs etc. Human Session 'current status / Enabled' card removed from Account Health." },
      { category: "Fix", text: "Browser auto-login no longer types the password into the username field — it now uses the Tab key to move focus from username to password, which is immune to Instagram's form re-render shifting coordinates." },
      { category: "Fix", text: "Embedded browser window now sets its size before showing, so it appears maximised to the work area immediately without a flash at the smaller starting size." },
      { category: "Fix", text: "Account settings Device Fingerprint timezone now shows your machine's actual local timezone instead of a randomly picked city that may contradict the account's proxy country." },
      { category: "Fix", text: "Account settings Profile Sync section now shows all controls (Auto Sync toggle, interval range, HikerAPI, Sync Now) on a single row instead of two stacked rows." },
    ],
  },
  {
    version: "1.0.910",
    date: "12 Jun 2026",
    items: [
      { category: "Fix", text: "Fixed the embedded browser window crashing (SIGSEGV) every time it opened — the crash was caused by the mobile layout flag in the device setup step. The browser now uses a compact mobile viewport and touch emulation without the flag that was causing Chromium to crash." },
      { category: "Fix", text: "Removed the screen orientation field from the ghost browser device setup that was supposed to have been removed in a previous version but was still present." },
      { category: "Feature", text: "Ban Analytics renamed to Evasion Stats with a new spy icon in the sidebar." },
      { category: "Feature", text: "Evasion Stats now has three tabs: Ban Events, Automated Behaviour, and Captcha Errors — each showing which API endpoints were called before the event, and the average call rate." },
      { category: "Feature", text: "Evasion Stats now shows a Proxy Risk Ranking table listing which proxy IPs appear most often across all three event types, so you can see which proxies are causing the most problems." },
      { category: "Feature", text: "Evasion Stats now shows Concurrent Usage Alerts when multiple accounts on the same proxy were flagged within 30 minutes of each other — a strong signal of suspicious pattern detection by Instagram." },
      { category: "Feature", text: "Accounts page now has two new flag options: Flag as Automated Behaviour and Flag as Captcha Error. Both snapshot the account's API call history into Evasion Stats but keep the account in Equinox so you can still verify and recover it." },
    ],
  },
  {
    version: "1.0.909",
    date: "12 Jun 2026",
    items: [
      { category: "Fix", text: "Verify now uses a fire-and-forget architecture — the browser manager responds immediately and runs the login in the background, then the app polls for the result every 3 seconds. This eliminates the 5-minute connection timeout that was killing verify." },
      { category: "Debug", text: "Added step-by-step timestamped logs throughout the login process (page load, form fill, submit, navigation, 2FA, session cookie check) so failures are now visible in the app logs with exact timing." },
    ],
  },
  {
    version: "1.0.908",
    date: "12 Jun 2026",
    items: [
      { category: "Fix", text: "Verify no longer fails with 'fetch failed' after 5 minutes — Node.js was cutting the connection to the browser manager at exactly 300 seconds, which is why verify always failed the same way. The timeout is now disabled so verify can run for as long as it needs." },
    ],
  },
  {
    version: "1.0.907",
    date: "12 Jun 2026",
    items: [
      { category: "Fix", text: "Removed the screenOrientation field from the browser device setup — it was crashing Chromium on Windows in Electron 33 when combined with mobile mode. The browser now opens correctly." },
    ],
  },
  {
    version: "1.0.906",
    date: "12 Jun 2026",
    items: [
      { category: "Fix", text: "Fixed the browser crash — the step logs revealed it was crashing at device metrics setup because floating CDP commands from the timezone and user-agent steps were still in-flight. Added drain delays and window-alive checks between every CDP block so commands are properly sequenced." },
    ],
  },
  {
    version: "1.0.905",
    date: "12 Jun 2026",
    items: [
      { category: "Fix", text: "Crash capture is now active: any error in the browser manager that previously caused a silent app crash will now appear in logs.log alongside the server output." },
      { category: "Fix", text: "Added 30 step-by-step progress markers inside the browser open sequence — the last marker visible in logs.log before a crash will show the exact failing step." },
    ],
  },
  {
    version: "1.0.904",
    date: "12 Jun 2026",
    items: [
      { category: "Fix", text: "Pressing the browser icon no longer crashes the app — fixed two additional crash points: the app was calling into the browser window up to 14 seconds into setup (after proxy timezone, user-agent, and device metric configuration) and again at the final navigation step, both without checking if the window was still alive." },
      { category: "Fix", text: "Ban Analytics now opens inside the app with the sidebar visible, instead of taking over the full screen." },
    ],
  },
  {
    version: "1.0.903",
    date: "12 Jun 2026",
    items: [
      { category: "Fix", text: "Pressing the browser icon on Accounts: added first round of safety guards so opening the browser panel while the window is still setting up never tries to attach toolbars or run scripts on a destroyed window." },
    ],
  },
  {
    version: "1.0.902",
    date: "12 Jun 2026",
    items: [
      { category: "Fix", text: "Clicking the browser icon on Accounts no longer crashes the app — the blank-screen recovery handler was missing error protection and could crash the main process on unexpected page states." },
      { category: "Fix", text: "TrustScore badges on the Statistics page are now correctly centred in their column." },
      { category: "Fix", text: "Execution order is now respected — Human Session (set to order 75) runs before Follow (set to order 1). Higher order number = runs first." },
    ],
  },
  {
    version: "1.0.901",
    date: "12 Jun 2026",
    items: [
      { category: "Fix", text: "Embedded browser blank screen: User-Agent and mobile device headers are now applied before the first page load instead of in the background — Instagram was seeing the raw Electron browser identity on the first request and returning an empty page." },
      { category: "Fix", text: "Embedded browser blank screen: the automatic blank-page recovery now waits 1.5 seconds before retrying and stops after 3 attempts — previously it could loop indefinitely and keep the screen blank." },
    ],
  },
  {
    version: "1.0.900",
    date: "12 Jun 2026",
    items: [
      { category: "Fix", text: "Login button: after filling in username the app was clicking the clear × button inside the field instead of tapping the password field — now re-queries the password field position after username validation settles." },
      { category: "Fix", text: "Login button: after filling in password the app was clicking the eye/reveal icon instead of the Sign In button — removed the overly broad button fallback that was matching icon buttons." },
      { category: "Fix", text: "Verify: silent background login now correctly taps the Sign In button instead of the password reveal icon." },
      { category: "Fix", text: "Embedded browser window no longer hides the Windows taskbar or obscures the close button — uses explicit work area bounds instead of maximize." },
      { category: "Fix", text: "Browser icon button on Accounts page now responds instantly — was previously frozen for up to 10 seconds while the window set itself up in the background." },
      { category: "Fix", text: "Accounts page no longer shifts layout when importing or deleting accounts — scrollbar space is now always reserved." },
      { category: "Fix", text: "TrustScore badges on the Statistics page are now centred in their column." },
      { category: "Fix", text: "Settings button now opens directly on the My Account tab instead of the General tab." },
    ],
  },
  {
    version: "1.0.899",
    date: "12 Jun 2026",
    items: [
      { category: "Fix", text: "Human Session: Skip Chance % and Exec Order labels restored on Follow, Unfollow, and Contact tool headers — a previous update had incorrectly renamed them to Run Chance % and Execution Order without approval." },
      { category: "Fix", text: "Ban Analytics: fixed crash when navigating to the page." },
    ],
  },
  {
    version: "1.0.898",
    date: "12 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser warm-up: websites are now visited in fully random order — the first website was previously used as a fixed landing page, causing it to be visited twice before any other site." },
      { category: "Fix", text: "Ghost Browser: Verification Code title now appears inline on the same row as the code input field instead of on its own separate row above." },
      { category: "New", text: "Ban Analytics: Flag as Banned in Accounts → Actions snapshots the account's full API call history, saves it to a ban analytics database, then removes the account — the new Ban Analytics page in the sidebar shows which endpoints appear most before bans." },
    ],
  },
  {
    version: "1.0.897",
    date: "12 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser: email domain is no longer typed twice — after typing, the value is now force-corrected to exactly the expected email if Instagram's JS injected a domain suggestion after the keystrokes." },
      { category: "Fix", text: "Human Session: execute order settings for Follow, Unfollow, and Contact tools now save and apply correctly — these fields were missing from the settings defaults so their values were never stored in the database." },
      { category: "Improve", text: "Human Session: session log now shows why each action was skipped (disabled or chance roll) to help diagnose unexpected session order." },
    ],
  },
  {
    version: "1.0.896",
    date: "11 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser: email domain no longer typed twice — added Ctrl+A + Backspace before typing to clear Instagram's re-populated domain suggestion before each field is filled." },
      { category: "Fix", text: "Ghost Browser: browser no longer opens on Instagram.com for any slot — fixed a check that only exempted slot 1 from the Instagram auto-navigation, leaving slots 2+ still landing on Instagram." },
    ],
  },
  {
    version: "1.0.895",
    date: "11 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser: Scheduler title now appears above the Run Every and Execute Signup After fields instead of inline on the same row." },
      { category: "Fix", text: "Ghost Browser: YouTube Warm-Up label and Skip Warmup checkbox are now vertically centred in their row instead of pinned to the top." },
      { category: "Fix", text: "Ghost Browser: browser now navigates to your first configured landing page immediately when Create Account fires, even if the window was already open on a different site." },
    ],
  },
  {
    version: "1.0.894",
    date: "11 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser: pressing Create Account now actually opens a visible browser window and starts the signup automation — the browser was silently launching in headless mode and never appearing on screen." },
      { category: "Fix", text: "Ghost Browser: Close Browser and Nuke buttons now correctly close the ghost window in all cases." },
    ],
  },
  {
    version: "1.0.893",
    date: "11 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser: restored the original full-width single-panel layout — the browser no longer appears embedded inline; it opens as a separate window as before." },
      { category: "Fix", text: "Ghost Browser: Open Browser and Close Browser buttons are back so you can launch or dismiss the browser window independently from running a signup." },
    ],
  },
  {
    version: "1.0.892",
    date: "11 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser: browser stream is back embedded in the panel — no phone chrome, correct aspect ratio, fully interactive." },
      { category: "Fix", text: "Ghost Browser: Create Account no longer flashes back immediately after clicking — the open call is now properly awaited and a retry handles the edge case where Electron hasn't registered the browser yet." },
      { category: "Fix", text: "Ghost Browser: email address no longer gets typed twice — autocomplete is disabled on the field before CDP begins typing." },
    ],
  },
  {
    version: "1.0.887",
    date: "11 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser: selected proxy is now remembered when switching between tabs — it no longer resets to 'No Proxy' when you navigate away and come back." },
      { category: "New", text: "Ghost Browser: the log header now shows a live progress percentage next to the active step — e.g. Step 1: Visiting Sites 37% — so you can see at a glance how far through each phase the run is." },
    ],
  },
  {
    version: "1.0.886",
    date: "11 Jun 2026",
    items: [
      { category: "New", text: "Ghost Browser: the browser is now embedded inline in the panel (phone frame) in all modes — no more separate window popping up on the side." },
      { category: "Fix", text: "Metrics page: Account Sync calls made via HikerAPI no longer appear in the Raw API Endpoint Count table — only direct Instagram API calls are shown." },
      { category: "New", text: "Ghost Browser: added Scheduler row with Run Every (minutes) and Execute Signup After (runs) X-Y range settings above the Warm-up Websites section." },
      { category: "New", text: "Ghost Browser: added Skip YouTube % X-Y range setting beside the Skip Warmup checkbox so you can randomly skip YouTube warm-up on a percentage of runs." },
    ],
  },
  {
    version: "1.0.885",
    date: "11 Jun 2026",
    items: [
      { category: "Fix", text: "Embedded browser: each account's stored device fingerprint (screen resolution, WebGL renderer, canvas noise, fake device IDs) is now loaded from the database when opening the EB, so the fingerprint is consistent across sessions instead of being randomised each time." },
      { category: "Fix", text: "Embedded browser: the account's API User-Agent (used to derive exact device screen dimensions) is now passed to the EB, so screen size, DPI and pixel ratio always match the UA rather than being picked at random." },
      { category: "Fix", text: "Embedded browser: if the profile config fails to load when opening the EB, a warning is now logged instead of silently opening with Electron's default desktop UA." },
    ],
  },
  {
    version: "1.0.884",
    date: "11 Jun 2026",
    items: [
      { category: "Fix", text: "Accounts page: Bulk Reset Device IDs now correctly resets device fingerprints — previously the button was silently blocked by the device guard and had no effect." },
      { category: "Fix", text: "Accounts page: Reset Device IDs + Clear Cookies similarly fixed — it now clears the session and assigns a new device fingerprint as intended." },
    ],
  },
  {
    version: "1.0.883",
    date: "11 Jun 2026",
    items: [
      { category: "Fix", text: "Activity ticker: system startup events no longer show as '@#0 Equinox started' in the top bar — startup events are now hidden from the ticker." },
      { category: "Fix", text: "Trust Score badge: the score list no longer appears transparent when the account row is greyed out (stopped) — it now renders on top with the correct solid background." },
      { category: "Fix", text: "Copy Settings dialog: trust score badges in the account list now display at a consistent fixed width, matching the badges on the Accounts page." },
      { category: "Fix", text: "Ghost Browser: IMAP fetch status message now appears inline to the right of the Fetch IMAP button instead of below it." },
      { category: "Fix", text: "Ghost Browser: YouTube warm-up step now tries multiple video selectors with fallback so it no longer silently skips when YouTube loads a different grid layout." },
      { category: "Fix", text: "Ghost Browser: signup birthday step no longer accidentally clicks the language selector — date dropdowns are now identified by their options rather than page position." },
      { category: "Fix", text: "Human Session tool: Randomise Timing setting now works — accounts with this enabled spread their first session start across the delay window even when manually toggled on." },
    ],
  },
  {
    version: "1.0.882",
    date: "11 Jun 2026",
    items: [
      { category: "New", text: "Equinox Bot: AI assistant available from the bottom-right corner — ask it anything about how to use the software. Click the robot icon to open, minimise back to the bubble, or close it entirely and re-open from Settings → General → Talk to Equinox Bot." },
      { category: "Fix", text: "Dashboard: importing an account via .eqx no longer shows the account username as a 'target' in the activity log — it is now shown only in the detail text." },
      { category: "Improvement", text: "Dashboard: exporting accounts as .eqx now logs each export with a position counter (e.g. '@username exported as .eqx 1/3')." },
    ],
  },
  {
    version: "1.0.881",
    date: "11 Jun 2026",
    items: [
      { category: "UI", text: "Ghost Browser: signup log header now shows step-by-step progress (Step 1: Visiting Sites → Step 2: YouTube Warm-up → Step 3: Instagram Signup) with the active step highlighted — skips warmup steps when Skip Warmup is ticked." },
      { category: "UI", text: "Ghost Browser: signup log text changed to the standard app font and capped at 15 visible rows; scrolling up pauses auto-scroll so you can read previous entries." },
      { category: "Fix", text: "Ghost Browser: Nuke Environment now clears the signup log." },
      { category: "UI", text: "Ghost Browser: default view now opens with 1 signup tab instead of 5; tabs are labelled Signup 1, Signup 2, etc." },
      { category: "UI", text: "Ghost Browser: YouTube Warm-Up card condensed to a single row (icon, name, and settings side by side); checkbox renamed to Skip Warmup." },
      { category: "UI", text: "Ghost Browser: removed Active IP and Active Device preview labels from the Proxy and Device Identity cards." },
      { category: "UI", text: "Ghost Browser: warm-up websites textarea is now 5 rows tall." },
      { category: "Fix", text: "Metrics page: HikerAPI calls are no longer shown in the Raw API Endpoint Count table — only calls made by the account itself are listed." },
      { category: "UI", text: "Metrics page: Raw API Endpoint Count table text is now black and in the standard font; click any column header to sort ascending or descending." },
    ],
  },
  {
    version: "1.0.880",
    date: "10 Jun 2026",
    items: [
      { category: "Feature", text: "IMAP verification codes are now fetched and submitted automatically — when Instagram asks for the code, the app polls your inbox every 12 seconds, enters the code, and continues the signup without any manual clicks." },
      { category: "Feature", text: "Create Account button turns into a red Stop button while a signup is running — click it to immediately halt the process." },
      { category: "Fix", text: "Signup log now appears as soon as you press Create Account (not just when entries arrive) and grows up to 400px tall with full text wrapping so every line is visible." },
    ],
  },
  {
    version: "1.0.879",
    date: "10 Jun 2026",
    items: [
      { category: "Feature", text: "Ghost Browser: added 'Skip all warm-up' checkbox next to Minutes per Video — tick it to go straight to the Instagram signup flow without visiting any websites or YouTube first." },
      { category: "Fix", text: "Ghost Browser signup log now expands to show all entries with full line wrapping — no more entries being hidden in a single fixed-height row." },
      { category: "Fix", text: "IMAP code fetch now works with GMX and other providers — fixed the UID lookup so the right messages are actually read, added TLS compatibility, and extended the search window to 30 minutes." },
    ],
  },
  {
    version: "1.0.878",
    date: "10 Jun 2026",
    items: [
      { category: "Fix", text: "Fixed blank screen on startup — the Ghost Browser device picker was passing the wrong value type to the UI component, crashing React before any page could load." },
      { category: "Fix", text: "Ghost Browser device picker now correctly shows the selected device and responds to selection changes." },
    ],
  },
  {
    version: "1.0.877",
    date: "10 Jun 2026",
    items: [
      { category: "Fix", text: "Fixed blank white screen on startup — a crash in any component now shows a readable error report instead of an empty window, so you can see exactly what went wrong." },
      { category: "Fix", text: "Ghost Browser verification code fetch now correctly targets the active tab slot so multi-tab signups don't mix up codes between tabs." },
    ],
  },
  {
    version: "1.0.876",
    date: "10 Jun 2026",
    items: [
      { category: "Feature", text: "Ghost Browser now has Tab 1 through Tab 5 at the top — each tab runs its own independent browser session so you can create multiple accounts simultaneously." },
      { category: "Fix", text: "Add to Equinox now correctly saves the device UA, proxy settings, date of birth, fingerprint, IMAP email details, and session cookies — previously most of these fields were silently dropped." },
      { category: "Feature", text: "When Add to Equinox is clicked for a username that already exists, the account's Notes field now logs a 'Re-added' timestamp instead of creating a duplicate." },
      { category: "Improvement", text: "Account Details section in Account Settings is now expanded by default so device, proxy, and fingerprint info is visible immediately without extra clicks." },
      { category: "Feature", text: "Ghost Browser cookies are now automatically captured at signup completion and attached to the account when you click Add to Equinox." },
    ],
  },
  {
    version: "1.0.875",
    date: "10 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser signup now continues running even when you switch to another tab or tool — the progress log picks up exactly where it left off when you return." },
      { category: "Feature", text: "Signup log: a scrollable activity log now appears at the bottom of the Ghost Browser panel showing every step of the signup process as it happens." },
      { category: "Improvement", text: "YouTube warm-up settings moved to their own clearly labelled card with the YouTube icon, separate from the website warm-up settings." },
      { category: "Fix", text: "Date of birth is now typed character-by-character instead of pasted — prevents Instagram from flagging it as bot input." },
      { category: "Fix", text: "Login button now correctly focuses the password field after filling the username — Instagram's form sometimes shifts after username validation and the tap now re-queries the live position." },
    ],
  },
  {
    version: "1.0.874",
    date: "10 Jun 2026",
    items: [
      { category: "Fix", text: "YouTube warm-up now reliably finds and watches videos — fixed a timing issue where the video selector ran before the page finished reloading after the consent banner was dismissed." },
      { category: "Fix", text: "YouTube warm-up now works with the mobile layout that Ghost Browser renders — added mobile YouTube selectors alongside desktop ones." },
      { category: "Fix", text: "If no videos are found on the YouTube homepage, the warm-up now automatically tries the YouTube search results page as a fallback before giving up." },
    ],
  },
  {
    version: "1.0.873",
    date: "10 Jun 2026",
    items: [
      { category: "Feature", text: "Ghost Browser warm-up now supports watching YouTube videos — set how many videos (X–Y) and how many minutes to watch each one (X–Y) before signup." },
      { category: "Fix", text: "YouTube warm-up now opens the full desktop YouTube and actually finds and plays videos — no more blank page or mobile (m.) version." },
      { category: "Improvement", text: "Removed the 'Active device' and 'Active proxy' labels that appeared under the proxy and device fields when the Ghost Browser was running — less clutter." },
    ],
  },
  {
    version: "1.0.872",
    date: "10 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost signup flow now actually runs — the progress log will show each step (warmup sites, form fill, verification) instead of sitting silent forever." },
      { category: "Fix", text: "Debug log now shows '[ghost-signup] IIFE started' on every run so you can confirm the flow is alive and see the server port it is using." },
    ],
  },
  {
    version: "1.0.871",
    date: "10 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser no longer shows 'Waiting for verification code' immediately when you click CREATE ACCOUNT — that message now only appears when the signup flow actually reaches the email verification step." },
      { category: "Fix", text: "Warmup websites now load correctly — the signup flow visits all configured sites before starting Instagram registration as expected." },
      { category: "Fix", text: "Restored all toolbar buttons (Login, 2FA, Phone, Email, Email Pass) to the Ghost Browser window." },
    ],
  },
  {
    version: "1.0.870",
    date: "10 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser URL bar is now always visible and usable — the toolbar no longer squishes it to zero width on the 430px Ghost Browser window." },
      { category: "Improvement", text: "Ghost Browser toolbar now shows only the essential buttons (Back, Forward, Reload, Home, URL bar, Leak Check) — Login, 2FA, Phone, Email and Email Pass are account-window tools not needed during signup." },
    ],
  },
  {
    version: "1.0.869",
    date: "10 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser URL bar now shows the correct address immediately on open — fixed a race condition where the toolbar loaded after the first navigation event." },
      { category: "Fix", text: "Removed the username preview line that kept flickering under the Username Spin field." },
      { category: "Improvement", text: "Signup status message now appears below the CREATE ACCOUNT button instead of above it." },
    ],
  },
  {
    version: "1.0.868",
    date: "10 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser no longer opens a blank page — the browser now navigates directly to the first website in your warm-up list (or Instagram if the list is empty)." },
      { category: "Fix", text: "Removed the 'Close Browser' button from the Ghost Browser panel — use Nuke Environment to reset the session." },
      { category: "Improvement", text: "Fingerprint expand button is now centred below the section title (like the Proxy and Device dropdowns) instead of being right-aligned with the heading." },
      { category: "Improvement", text: "CREATE ACCOUNT, ADD TO EQUINOX and NUKE ENVIRONMENT buttons are now left-aligned." },
      { category: "Improvement", text: "Websites in the warm-up list are automatically removed one by one as the Ghost Browser finishes visiting each one." },
    ],
  },
  {
    version: "1.0.867",
    date: "10 Jun 2026",
    items: [
      { category: "Fix", text: "Native Ghost Browser toolbar buttons no longer overlap when the window is narrower — buttons now hold their full width and any that don't fit are cleanly hidden at the edge." },
      { category: "Fix", text: "Ghost Browser signup no longer continues running in the background after you close or reset the browser. Closing the window now immediately stops any in-progress warm-up or signup flow." },
      { category: "Fix", text: "Closing and re-opening the Ghost Browser no longer causes the previous session's warm-up timer to fire into the new session, producing out-of-order status messages or jumping straight to 'waiting for verification code'." },
    ],
  },
  {
    version: "1.0.866",
    date: "10 Jun 2026",
    items: [
      { category: "Improvement", text: "Removed the 'Open Browser Only' button — CREATE ACCOUNT is the only trigger for opening the Ghost Browser." },
      { category: "Improvement", text: "Ghost Browser now opens directly on the first website in your warm-up list instead of Instagram's homepage." },
      { category: "Improvement", text: "All four X–Y range fields (Websites to Visit, Internal Links, Time on Site, Time on Links) are now on one compact row so the settings panel is shorter." },
      { category: "Improvement", text: "Verification code input is now compact (8 characters wide) instead of stretching across the full row." },
      { category: "Improvement", text: "CREATE ACCOUNT, ADD TO EQUINOX and NUKE ENVIRONMENT buttons are now 20% narrower and centred rather than spanning the full panel width." },
      { category: "Fix", text: "Native Ghost Browser toolbar buttons no longer overlap or show garbled text when the window is made smaller — text is now clipped cleanly at the toolbar edge." },
    ],
  },
  {
    version: "1.0.865",
    date: "9 Jun 2026",
    items: [
      { category: "Feature", text: "Ghost Browser settings panel is now 3x wider with all controls laid out in clearly labelled rows — proxy, device identity and fingerprint sit side by side on row 1 so you can see everything at a glance." },
      { category: "Feature", text: "New Website Warm-Up section: add a list of websites for the Ghost Browser to visit in random order before signup. It automatically accepts cookie consent banners on every page." },
      { category: "Feature", text: "X–Y range controls for how many websites to visit, how many internal links to click per site, and how many minutes to spend on each — all configurable with three-digit-wide inputs." },
      { category: "Feature", text: "Ghost Browser now browses your warm-up websites (clicking internal links, spending natural time on each page) before ever touching Instagram — creates a genuine browsing history in the session." },
      { category: "Improvement", text: "CREATE ACCOUNT and ADD TO EQUINOX buttons now display in uppercase for clarity. All field action buttons renamed from 'Paste' to 'Type' to better reflect what they do." },
      { category: "Improvement", text: "Ghost Browser native window now opens at the absolute right edge of your screen instead of centred, keeping it out of the way of the settings panel." },
    ],
  },
  {
    version: "1.0.864",
    date: "9 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser now shows a blocked (no-entry) cursor when you hover over it during automation — Instagram cannot track mouse movements and you get a clear visual that the window is under automation control." },
      { category: "Fix", text: "Date of birth drum picker now appears correctly — the browser was incorrectly advertising hover/pointer capability like a desktop, causing Instagram to show a plain text input instead of the phone-style spinning picker." },
    ],
  },
  {
    version: "1.0.863",
    date: "9 Jun 2026",
    items: [
      { category: "Fix", text: "Signup flow no longer stalls on the cookie banner — the mouse blocker was incorrectly blocking 'click' events, which also killed the touch-tap click that dismisses the cookie dialog." },
    ],
  },
  {
    version: "1.0.862",
    date: "9 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser now opens as a portrait phone-sized window (430×932) instead of full-screen — Instagram always serves the mobile layout." },
      { category: "Fix", text: "Mobile viewport (393×851, touch enabled) is now applied immediately when the Ghost Browser opens, not just during automated signup — you now see the mobile Instagram interface when browsing manually too." },
      { category: "Fix", text: "Date of birth: tapping the field now checks whether a drum picker opens (it only appears after a tap on mobile). If it opens, the drum columns are scrolled; if not, the value is set directly via JavaScript so it always lands correctly." },
      { category: "Fix", text: "Signup automation now blocks mouse hover and mousedown/mouseup events during the flow — Instagram's fraud detection can no longer see mouse movement or button presses." },
    ],
  },
  {
    version: "1.0.861",
    date: "9 Jun 2026",
    items: [
      { category: "New", text: "Ghost Browser now displays inside a phone frame shell at mobile resolution (393×851) so the signup flow looks exactly like a real Android screen." },
      { category: "Fix", text: "Signup automation: the date-of-birth drum picker now correctly taps the 'Set' confirmation button after scrolling — previously the flow was stalling because only 'Next' was being searched for." },
    ],
  },
  {
    version: "1.0.860",
    date: "9 Jun 2026",
    items: [
      { category: "Removed", text: "Ghost Browser toolbar: removed the 'My IP' button that was added without approval." },
      { category: "Fix", text: "Signup automation: all input fields now use touch tap events instead of desktop keyboard events — matches real mobile Instagram behaviour." },
      { category: "Fix", text: "Signup automation: the 6-digit verification code is now entered one digit per box using touch taps and IME input — Instagram auto-submits when the last box is filled, with no Confirm button click needed." },
      { category: "Fix", text: "Signup automation: Date of Birth now detects and interacts with Instagram's mobile scroll-wheel picker (Day / Month / Year columns) using touch scroll gestures, rather than trying to type into a text field." },
    ],
  },
  {
    version: "1.0.859",
    date: "9 Jun 2026",
    items: [
      { category: "Removed", text: "Mirror tab has been removed from the sidebar and all of its backend code has been deleted." },
      { category: "Fix", text: "Ghost Browser: placeholder text in Username Spin, Date of Birth, and Email Password fields now uses the same font as the IMAP fields (was monospace, now matches)." },
      { category: "Improvement", text: "Ghost Browser: Proxy, Device Identity, and Fingerprint cards are now closer together vertically." },
    ],
  },
  {
    version: "1.0.858",
    date: "9 Jun 2026",
    items: [
      { category: "New", text: "Ghost Browser toolbar: added a 'My IP' button — click it at any time to instantly see your current exit IP and confirm whether the Ghost Browser is routing through your proxy, phone hotspot, or home broadband." },
      { category: "Improvement", text: "Proxy Manager: added a 'Using Phone 4G?' tip panel explaining why hotspotting your laptop still shows your home broadband IP and giving step-by-step instructions for both the proxy-app fix and the disconnect-home-broadband fix." },
    ],
  },
  {
    version: "1.0.857",
    date: "9 Jun 2026",
    items: [
      { category: "Fix", text: "Mirror: go-ios download now uses a case-insensitive asset name filter — the real cause of 'No Windows ZIP found' was that GitHub release assets are named 'Windows' (capital W) but the filter checked for 'windows' (lowercase). Fixed plus added 4 versioned fallback URLs so download still works even if the GitHub API is rate-limited." },
      { category: "New", text: "Mirror: Screen now works without any certificate or app install. Once go-ios downloads, your iPhone screen appears immediately — no WDA, no Apple developer trust step needed." },
      { category: "New", text: "Mirror: Touch, swipe, and hardware buttons (Home, Volume, Power) now work through go-ios HID — same approach, no certificate install needed." },
      { category: "New", text: "Mirror: New 'go-ios active' status badge and banner replace the old WDA setup checklist when go-ios is connected. Install Control Agent remains available as an optional upgrade for higher FPS and text input." },
    ],
  },
  {
    version: "1.0.856",
    date: "9 Jun 2026",
    items: [
      { category: "Fix", text: "Mirror: Switched to go-ios (a DLL-free replacement binary) for device listing, port forwarding, and WDA installation — eliminates the usbmuxd.dll crash that has been blocking the mirror on all modern iTunes installs." },
      { category: "Fix", text: "Mirror: WDA download now tries the Appium GitHub releases API first to always grab the latest signed IPA, with 3 versioned fallback URLs — the dead nicowillis URL is no longer the only option." },
      { category: "Fix", text: "Mirror: If all automatic install paths fail, the error message now shows clear Sideloadly instructions instead of a generic 'download failed' error." },
      { category: "Improvement", text: "Mirror: go-ios is downloaded once in the background at startup and cached, so it's ready by the time you open the Mirror page." },
    ],
  },
  {
    version: "1.0.855",
    date: "9 Jun 2026",
    items: [
      { category: "Fix", text: "Mirror: Apple DLLs are now copied into Equinox's own bin folder at startup — this is the real fix for idevice_id.exe crashing (PATH injection fails because Windows loads static DLL imports before the process runs, so PATH is never consulted)." },
      { category: "Fix", text: "Mirror: The installer now bundles a real WebDriverAgent.ipa when the CI build can find one, and skips gracefully when it can't — no more dead download URL errors." },
    ],
  },
  {
    version: "1.0.854",
    date: "9 Jun 2026",
    items: [
      { category: "Fix", text: "Mirror: iPhone was never detected because Windows was silently ignoring the Apple DLL path injection — a Windows-specific bug where 'Path' and 'PATH' are treated as different keys. Fixed by stripping all case variants before setting the correct one." },
      { category: "Fix", text: "Mirror: 'Install control agent' step in the checklist no longer shows as ticked when the agent was never actually installed — it only ticks after a confirmed successful install now." },
    ],
  },
  {
    version: "1.0.853",
    date: "9 Jun 2026",
    items: [
      { category: "Fix", text: "Mirror: Reinstall Control Agent now actually works — a race condition was causing iproxy to silently restart itself the moment you clicked Reinstall, leaving the UI frozen and the install never starting." },
    ],
  },
  {
    version: "1.0.852",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "Mirror: 'Reinstall Control Agent' no longer silently fails with HTTP 404 — it now checks for a bundled control agent first, and gives a clear message if the download is unavailable instead of a cryptic error code." },
      { category: "Fix", text: "Mirror: Reinstall now correctly injects Apple's DLL paths when running the installer — fixes a crash where ideviceinstaller.exe couldn't find Apple's libraries even though iTunes was installed." },
      { category: "Fix", text: "Mirror: Reinstall now shows a clear message if your iPhone isn't detected yet, instead of silently doing nothing." },
      { category: "Fix", text: "Mirror: Moved 'Reinstall' into a collapsed section so the primary 'open WDA on your iPhone' instruction is more obvious." },
    ],
  },
  {
    version: "1.0.851",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "Mirror: 'Reinstall Control Agent' button was broken — it stopped the connection but never actually started the reinstall. Now clicking it correctly stops the connection and immediately kicks off a fresh WDA install." },
    ],
  },
  {
    version: "1.0.850",
    date: "8 Jun 2026",
    items: [
      { category: "New", text: "Added Equinox-Standalone artifact to every build — download the ZIP, double-click start.bat, and the full app runs in your browser instantly with no installer needed. Fast 2-3 min build instead of waiting for the full installer." },
    ],
  },
  {
    version: "1.0.849",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "Mirror: when your iPhone is plugged in but Equinox still can't see it (Trust dialog, charge-only cable, locked screen), the setup screen now shows clear step-by-step instructions instead of a misleading green 'ready' banner." },
      { category: "New", text: "Mirror: added a 'Restart Apple Service' button — fixes cases where Apple's USB service is running but stuck seeing zero devices, without needing to open Windows Services manually." },
    ],
  },
  {
    version: "1.0.848",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "Mirror: when the white icon is missing and no certificate appears in Settings, the screen now explains why (the install never completed) and shows a prominent Reinstall button — no more hunting for a tiny link." },
    ],
  },
  {
    version: "1.0.847",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "Mirror: added a Reinstall button on the Connecting screen so you can go back and reinstall the control agent without restarting the app — useful when the old certificate was removed and a fresh install is needed to get a new one." },
    ],
  },
  {
    version: "1.0.846",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "Mirror: the 'Connecting' screen now shows the correct instructions — find the WebDriverAgent app on your iPhone home screen (plain white icon, or search for it in Spotlight) and tap it to start. The old trust-certificate instructions are still there as a collapsible section for first-time installs." },
    ],
  },
  {
    version: "1.0.845",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "Mirror: after installing the control agent, the app was stuck showing just a spinning 'Connecting...' with no guidance. It now shows clear step-by-step instructions: open Settings → General → VPN & Device Management, trust the developer certificate, and Equinox will connect automatically." },
    ],
  },
  {
    version: "1.0.844",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "Mirror: iPhone was never detected even when plugged in and trusted. The device list parser had a bug where it always read the wrong part of Apple's response and found zero devices. Fixed — your phone should now appear automatically once plugged in and the Install Control Agent button will show up." },
    ],
  },
  {
    version: "1.0.843",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "Mirror Controls tab now correctly shows 'Direct connection active — plug in your iPhone' (green) instead of the amber 'USB bridge not available' warning when modern iTunes is installed but your iPhone isn't plugged in yet. The previous version confused 'no phone connected' with 'connection broken'." },
    ],
  },
  {
    version: "1.0.842",
    date: "8 Jun 2026",
    items: [
      { category: "New", text: "Mirror Controls tab now shows a green callout explaining that your phone stays on its 4G/cellular connection — USB only carries screen and touch, so Instagram always sees your phone's real mobile IP." },
      { category: "New", text: "Wireless Mirror tab now includes a note that WiFi mirroring is not suitable for creating new Instagram accounts on 4G — use USB mode for signups." },
      { category: "Fix", text: "Added a Windows Firewall fix to the Wireless Mirror tab — if your iPhone can't connect, a one-click PowerShell command opens port 7000 so the AirPlay receiver is reachable." },
    ],
  },
  {
    version: "1.0.841",
    date: "8 Jun 2026",
    items: [
      { category: "New", text: "Wireless Mirror — your iPhone can now mirror its screen to Equinox over WiFi with no USB cable, no iTunes drivers, and no app to install. Open the iPhone Mirror tool, go to the Wireless Mirror tab, click Start, then on your iPhone open Control Center → Screen Mirroring → Equinox Mirror." },
      { category: "New", text: "AirPlay receiver built into Equinox — it advertises itself on your local network using the same mDNS protocol Apple TV uses, so it appears instantly in your iPhone's Screen Mirroring list." },
      { category: "New", text: "H.264 video stream is decoded in hardware using the browser's built-in WebCodecs API — no extra software needed, works on any modern PC." },
    ],
  },
  {
    version: "1.0.840",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "Mirror tool now detects iPhones without needing any Apple DLLs — it talks directly to Apple's device service over TCP, completely bypassing the usbmuxd.dll that modern iTunes no longer ships." },
      { category: "Fix", text: "Mirror tool USB tunnel (iproxy) now also uses direct TCP when the iproxy.exe tool can't load, so both detection and connection work even without the old Apple DLLs." },
      { category: "Fix", text: "Mirror diagnose panel now shows the correct message — 'Direct connection active' in green when TCP detection is working, or a clear 'plug in your iPhone' prompt if no device is found yet. No more misleading iTunes repair instructions." },
    ],
  },
  {
    version: "1.0.839",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "Mirror tool now injects ALL known Apple directories into PATH when running the iPhone communication tool — Mobile Device Support, Apple Application Support, and the iTunes app folder — so a fresh iTunes install works regardless of which directory Apple chose for each DLL." },
      { category: "Fix", text: "Mirror tool DLL detection now also checks for iTunesMobileDevice.dll, CoreFoundation.dll, and the Apple service executable — covering what fresh iTunes actually ships instead of only looking for older DLL names." },
    ],
  },
  {
    version: "1.0.838",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "Mirror tool now correctly identifies when the iPhone communication tool crashes because an Apple DLL isn't loading — instead of showing 'can't communicate', it now shows a clear 'iTunes driver not loading correctly' card with step-by-step fix instructions." },
      { category: "Fix", text: "Mirror tool DLL search now checks more locations including the iTunes app folder and Apple Application Support, covering all standard iTunes install layouts." },
      { category: "Fix", text: "Mirror tool now also looks for AppleMobileDeviceLibrary.dll in addition to AppleMobileDeviceInterface.dll — older iTunes versions use the library name." },
    ],
  },
  {
    version: "1.0.837",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "Mirror tool now detects Microsoft Store iTunes and shows a clear error explaining it's not compatible — and how to switch to the proper Apple website version." },
      { category: "Fix", text: "All Mirror tool log messages now include the full error text inline so they're visible in the debug log file regardless of format." },
    ],
  },
  {
    version: "1.0.836",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "Added full debug logging to the Mirror tool — every step (binary path, DLL path, exact command, stdout, stderr, exit code) now appears in the log file so connection failures can be diagnosed properly." },
    ],
  },
  {
    version: "1.0.835",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "Mirror tool now tells libimobiledevice to connect via Apple's USB socket (port 27015) — this was the root cause of the iPhone not being detected even when visible in Windows Explorer." },
      { category: "Fix", text: "Added data cable and USB 2.0 port tip to the troubleshooting checklist — charge-only cables and USB 3.0 ports can prevent iPhone communication." },
      { category: "Fix", text: "Troubleshooting panel now clearly states: no special app or setting needed on the iPhone itself." },
      { category: "Fix", text: "Added collapsible 'Technical details' section to the troubleshooting panel for easier support diagnostics." },
    ],
  },
  {
    version: "1.0.834",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "Mirror tool no longer shows the misleading 'iPhone detected but locked' message when your phone is already unlocked — replaced with a clear numbered checklist covering all possible causes." },
      { category: "Fix", text: "New troubleshooting panel guides you step-by-step: unlock screen → check Trust popup → replug cable → restart Apple Mobile Device Service." },
    ],
  },
  {
    version: "1.0.833",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "Mirror tool no longer shows 'iPhone detected but locked' when your phone is actually unlocked — it now correctly detects when the issue is a missing 'Trust This Computer' confirmation instead." },
      { category: "Fix", text: "New 'Tap Trust on your iPhone' message now appears with clear instructions when your phone is connected and unlocked but hasn't authorised this PC yet." },
      { category: "Fix", text: "The 'screen is locked' message now also reminds you to check for the Trust popup in case that's the real issue." },
    ],
  },
  {
    version: "1.0.832",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "iPhone still not detected after iTunes already installed: Equinox now injects Apple's USB driver path directly when talking to your iPhone, fixing a silent failure when iTunes is installed from the Microsoft Store." },
      { category: "Fix", text: "If your iPhone is plugged in but screen is locked, Equinox now tells you clearly: 'Unlock your iPhone then check again'." },
      { category: "Fix", text: "If detection fails with a real error, the exact error message now shows so you know exactly what's wrong." },
    ],
  },
  {
    version: "1.0.831",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "iPhone not detected: Equinox now diagnoses why and tells you exactly what to fix — most commonly iTunes needs to be installed for Windows to see your iPhone." },
      { category: "Fix", text: "Added a 'Download iTunes' button inside the app when the Apple USB driver is missing — one click takes you straight to Apple's download page." },
      { category: "Fix", text: "'Check again' button now re-runs detection after you've made a change, without needing to restart the app." },
    ],
  },
  {
    version: "1.0.830",
    date: "8 Jun 2026",
    items: [
      { category: "Improvement", text: "iPhone Control is now fully built-in — no CMD prompts, no Sideloadly, no Python. Plug in your iPhone and Equinox handles everything automatically." },
      { category: "Improvement", text: "libimobiledevice binaries (idevice_id, iproxy, ideviceinstaller) are now bundled inside the app — device detection and port forwarding happen internally with no external tools needed." },
      { category: "Improvement", text: "iproxy now auto-starts inside Equinox when your iPhone is detected — you no longer need to run any background command." },
      { category: "Improvement", text: "One-click 'Install Control Agent' button in Equinox downloads and installs the control bridge directly onto your iPhone — no Apple ID or Sideloadly required." },
      { category: "Improvement", text: "Control tab now shows a clear step-by-step progress indicator (Plug in → Trust → Install → Connect) so you always know exactly where you are." },
    ],
  },
  {
    version: "1.0.829",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "Mirror setup instructions completely rewritten — Windows-specific, step-by-step, no Mac or Xcode required. Screenshots tab shows 3 steps (pip install tidevice, plug in, trust). Full control tab explains Sideloadly + WDA installation on Windows with copy-paste commands." },
    ],
  },
  {
    version: "1.0.828",
    date: "8 Jun 2026",
    items: [
      { category: "New", text: "Mirror tool added — connect your iPhone via USB and mirror its screen directly inside Equinox. Click anywhere on the preview to tap, or drag to swipe." },
      { category: "New", text: "Mirror tool: iPhone Signup tab imports the Ghost Browser signup flow so you can auto-fill Instagram registration forms directly on your real iPhone using WebDriverAgent." },
      { category: "New", text: "Mirror tool: built-in control pad with hardware button shortcuts (Home, Power, Volume), swipe D-pad, and a text input field for typing on the iPhone keyboard." },
    ],
  },
  {
    version: "1.0.827",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser signup: navigator.languages was reporting '[\"en-US\",\"en;q=0.9\"]' — the HTTP Accept-Language q-weight was leaking into the JavaScript API. Real Android Chrome always strips q-values and gives [\"en-US\",\"en\"]. This has been corrected." },
      { category: "Fix", text: "Ghost Browser signup: hardwareConcurrency was randomly picking 4 from the desktop fingerprint pool. The Pixel 8 has 8 cores (Tensor G3). Now pinned to 8." },
    ],
  },
  {
    version: "1.0.826",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser signup: the name field was being left blank on every signup — 'leaving blank, clicking Next'. A blank name on account creation is one of the clearest bot signals Instagram's risk model looks for. The signup now generates and types a random realistic first and last name (e.g. 'Emma Johnson') instead of skipping the field." },
      { category: "Debug", text: "Ghost Browser signup: a fingerprint diagnostic snapshot is now logged at the start of every signup session, showing exactly what navigator.platform, maxTouchPoints, screen dimensions, orientation, pointer type, connection type, plugins, and deviceMemory the browser reports. This lets you verify every signal before it reaches Instagram's servers." },
    ],
  },
  {
    version: "1.0.825",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser signup: every account created was getting the same canvas fingerprint, the same WebGL renderer, and the same audio hash because all signups use the same 'Pixel 8' UA which seeds the fingerprint randomiser to the same value every time. Instagram was clustering all ghost-signup accounts by canvas fingerprint and banning them in batches. Each signup session now generates its own random canvas noise, WebGL GPU identity, and audio fingerprint." },
      { category: "Fix", text: "Ghost Browser signup: all keyboard input now uses Android IME key codes (key='Unidentified', windowsVirtualKeyCode=229) instead of Windows virtual key codes. On Android, every key from the virtual keyboard fires VK_PROCESSKEY (229) — sending the actual character code (e.g. 65 for 'A') is a hard Windows desktop signal." },
      { category: "Fix", text: "Ghost Browser signup: screen.orientation was still reporting 'landscape-primary' (Electron's desktop default) even though the viewport was set to 393x851 portrait. Instagram reads screen.orientation to classify the device type. Now correctly reports 'portrait-primary'." },
      { category: "Fix", text: "Ghost Browser signup: window.visualViewport, window.ontouchstart, and window.matchMedia pointer/hover queries (belt-and-suspenders on top of CDP touch emulation) are now all correctly set to match a real Android phone." },
    ],
  },
  {
    version: "1.0.824",
    date: "8 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser signup: date of birth page now interacts with the mobile scroll-wheel drum picker using real touch swipe gestures (CDP synthesizeScrollGesture). Previously the code tried to find <select> elements or type into a text field — neither exist on the mobile UI. The drum picker requires swiping each column, which is now done correctly." },
      { category: "Fix", text: "Ghost Browser signup: performance.memory (desktop-only Chrome API) is now hidden. Android Chrome does not expose this API and Instagram's device classifier checks for its presence to distinguish mobile from desktop." },
      { category: "Fix", text: "Ghost Browser signup: navigator.keyboard (desktop Keyboard Lock API) is now hidden. Present in desktop Chrome, absent in Android Chrome — another device-type signal Instagram can read." },
    ],
  },
  {
    version: "1.0.823",
    date: "7 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser signup: screen.width was reporting 1920 (Windows desktop) even though the UA said Pixel 8 Android — an instant bot signal. The ghost browser opens without a mobile UA so the fingerprint script ran in desktop mode and locked screen dimensions as non-configurable. Fixed by making all fingerprint property overrides configurable so a dedicated mobile patch injected at signup time can correct them to 393×851 Pixel 8 values." },
      { category: "Fix", text: "Ghost Browser signup: navigator.plugins now returns an empty list. Desktop Chrome always exposes a PDF Viewer plugin — Android Chrome has zero plugins. This mismatch was detectable by Instagram's device classifier." },
      { category: "Fix", text: "Ghost Browser signup: navigator.connection.type now always reports 'cellular' when signing up. Previously it randomly showed 'wifi' 75% of the time even when the 4G SIM was the active network." },
      { category: "Fix", text: "Ghost Browser signup: the browser now emits fake DeviceMotionEvent and DeviceOrientationEvent data at ~60 Hz. Real phones continuously report accelerometer and gyroscope readings — a desktop Chrome never does. Instagram's risk engine may use sensor activity as a device signal." },
    ],
  },
  {
    version: "1.0.822",
    date: "7 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser signup: fields are now typed character-by-character with human-like random delays (80–280 ms between keys) instead of being pasted all at once. Instagram's keystroke-timing analyser treats an instant paste as a bot signal regardless of how the click got there." },
      { category: "Fix", text: "Ghost Browser signup: your PC mouse hovering over the Electron window no longer leaks mouse events to Instagram. A capture-phase JavaScript blocker is now injected before Instagram's scripts load, silently swallowing all mousemove/pointermove/mouseover events so Instagram only ever sees the touch events our automation sends." },
    ],
  },
  {
    version: "1.0.821",
    date: "7 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser signup: all navigation clicks now use touch-typed events only. Replaced every JS element.click() and mouse-typed CDP event in the signup flow with Input.dispatchMouseEvent using pointerType:\"touch\", matching what a real Android phone sends. This removes mouse signal leaks that Instagram can detect as desktop automation." },
    ],
  },
  {
    version: "1.0.820",
    date: "7 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser signup: date of birth is now actually typed. Previous attempts were editing the wrong file — the ghost signup runs entirely in the Electron layer (ebManager.ts), not the server-side signup code that was being changed. The fix adds a fallback in the correct file: after the existing dropdown/select attempts, it detects Instagram's current single combined date field, logs a full diagnostic, and types the date (MM/DD/YYYY format) via the same CDP keyboard path used for all other fields." },
    ],
  },
  {
    version: "1.0.819",
    date: "7 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser signup: date of birth now reliably typed into Instagram's current birthday form. Removed dependency on placeholder/aria-label attribute matching (Instagram's React app does not always set these in the DOM). The fix now waits for any visible input to appear, dumps a full diagnostic of every input and select on the page to the log, then types the date into the first visible non-hidden input using real keyboard events — this works regardless of how Instagram labels the field." },
    ],
  },
  {
    version: "1.0.818",
    date: "7 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser signup: date of birth now correctly fills the single 'Birthday (MM/DD/YYYY)' text field that Instagram currently shows. Instagram changed its DOB page from three dropdown selects to one combined text input — the previous code looked for separate month/day/year fields which no longer exist, so nothing was entered. The fix detects which form type is showing (combined text input vs dropdowns) and types the date using real keyboard events in MM/DD/YYYY format so React's onChange handler registers each keystroke." },
    ],
  },
  {
    version: "1.0.817",
    date: "7 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser signup: date of birth form now fills correctly. The previous code used plain el.value assignment which React's controlled components silently ignore. The fix uses the native HTMLSelectElement prototype setter (bypassing React's override) and fires both 'input' and 'change' events — both are required for React to register the selection. Includes a positional fallback (month/day/year order) if Instagram's select labels change, and an input-field fallback for alternate signup flows." },
    ],
  },
  {
    version: "1.0.816",
    date: "7 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser signup: email field (and all other form fields) now focus correctly before typing. The app now uses JavaScript element.focus() and .click() to activate the field before clearing and typing — CDP tap events don't reliably trigger React's form focus handler, which left the field empty and caused 'Email required' when Next was clicked." },
      { category: "Fix", text: "Ghost Browser signup: each field now logs its actual value after typing so you can see in the log whether the text landed correctly." },
    ],
  },
  {
    version: "1.0.815",
    date: "7 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser signup: 'Sign up' and 'Sign up with email' navigation now uses JavaScript element.click() instead of CDP touch events. CDP touch events fire raw touch signals that Instagram's React SPA ignores for navigation — the URL stayed at instagram.com for 20 seconds every attempt. JS click fires React's synthetic event system and triggers real SPA navigation." },
      { category: "Fix", text: "Ghost Browser signup: 'Sign up' click now searches by link href (/accounts/signup) first, then falls back to exact text match — href-based detection is more reliable than text matching which can pick up the wrong element on Instagram's homepage." },
    ],
  },
  {
    version: "1.0.814",
    date: "7 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser signup: the browser now forces mobile layout (Pixel 8, Chrome 131, 393×851 viewport) via CDP before navigating to Instagram — this is required because on the desktop layout, clicking 'Sign up' opens a pop-up with no URL change instead of navigating to /accounts/signup/phone." },
      { category: "Fix", text: "Ghost Browser signup: all step-by-step debug messages now appear directly in the server log file so failures are immediately visible without checking a separate Electron debug log." },
    ],
  },
  {
    version: "1.0.813",
    date: "7 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser signup: clicking 'Sign up' on the homepage now performs a real tap on the button — no more direct URL navigation (which Instagram detects and blocks). The app waits for the URL to reach /accounts/signup/phone before clicking 'Sign up with email'." },
      { category: "Fix", text: "Ghost Browser signup: 'Sign up with email' is now only clicked after the URL is confirmed at /accounts/signup/phone. The email form step only runs once the URL confirms /accounts/signup/email." },
      { category: "Improve", text: "Ghost Browser signup: added dense debug logging at every step — clickable element dumps, URL snapshots before and after each click, and clear error messages explaining why each step failed." },
    ],
  },
  {
    version: "1.0.812",
    date: "7 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser signup: the browser now starts on the Instagram homepage (not emailsignup/) so the session cookies are set before navigating to the signup page. Direct emailsignup/ navigation was being blocked by Instagram and dumping the browser back on the homepage." },
      { category: "Fix", text: "Ghost Browser signup: after the cookie banner is dismissed, the app now navigates directly to instagram.com/accounts/signup/ (the phone gate) instead of trying to click the 'Sign up' link — the homepage 'Log in or sign up' link was being matched incorrectly and did not navigate to the right page." },
    ],
  },
  {
    version: "1.0.811",
    date: "7 Jun 2026",
    items: [
      { category: "Fix", text: "Migrated to new Replit environment — app now runs correctly with the API server on port 8080 and the frontend Vite proxy updated to match." },
      { category: "Fix", text: "Login no longer shows 'Connection failed' — CORS and session handling corrected for the Replit preview environment." },
    ],
  },
  {
    version: "1.0.810",
    date: "7 Jun 2026",
    items: [
      { category: "Fix", text: "Replit Ghost Browser signup: navigation now starts at the Instagram homepage and taps through — 'Sign up' link → phone gate → 'Sign up with email' — using synthesizeTapGesture (mobile touch only, no mouse events). All field input uses tap to focus, JS native setter to clear, and Input.insertText to type. Blur replaces Tab key. Identical to the Windows Electron implementation." },
    ],
  },
  {
    version: "1.0.809",
    date: "7 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser: entire signup flow is now tap-only (synthesizeTapGesture). Removed all mouse events and keyboard key events from cookie click, Sign up link click, and text input. Fields are cleared via JS and text is inserted via Input.insertText — identical to how a real mobile virtual keyboard works, leaving no desktop fingerprint." },
    ],
  },
  {
    version: "1.0.808",
    date: "7 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser: 'Sign up' click uses href-based link detection (finds the link by its URL, not just label text) with tap + JS click fallback." },
    ],
  },
  {
    version: "1.0.807",
    date: "7 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser: after accepting the cookie banner, Instagram sometimes redirects back to the homepage instead of the email signup form. The tool now detects this and automatically re-navigates to the email signup page, so account creation continues without getting stuck." },
      { category: "Fix", text: "Ghost Browser: removed the yellow 'Waiting for verification code via IMAP' prompt — only the first step log balloon is shown while waiting for the code." },
      { category: "Fix", text: "Ghost Browser: Nuke Environment button is now always clickable, even while the signup tool is running, so you can abort and reset at any time." },
    ],
  },
  {
    version: "1.0.806",
    date: "7 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser 'not open' warning — root cause properly fixed. The browser window becomes visible before its internal registration completes (due to async setup), so the status check always saw it as closed for the first several seconds. The window is now registered the instant it is created, so the status is accurate immediately and the warning no longer appears." },
    ],
  },
  {
    version: "1.0.805",
    date: "7 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser 'not open' warning: the status poll introduced in v1.0.804 was actively setting the browser state to 'closed' whenever it checked the server during the window-opening sequence — the open call returns before the window is fully registered, so the poll was always racing against itself. The poll now only ever auto-discovers a browser that was opened before the app started; it never overrides an explicit 'Open Browser' click." },
      { category: "Fix", text: "Automated Behaviour Detected white screen: when any account's embedded browser lands on Instagram's scraping_warning page (which arrives as an empty HTML shell), an overlay is now injected after 2 seconds explaining what happened and what to do next." },
    ],
  },
  {
    version: "1.0.804",
    date: "7 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser: cookie banner auto-dismiss no longer taps 'Log In' after closing the banner — that tap was navigating the Ghost Browser to the login page and breaking the signup flow entirely." },
      { category: "Fix", text: "Ghost Browser page fields (username, password, date of birth, email, IMAP settings, bio) are now saved to local storage and restored on restart — restarting the software no longer clears the form." },
      { category: "Fix", text: "Ghost Browser status now refreshes every 5 seconds instead of only on page load, so the 'Ghost Browser is not open' warning goes away correctly once the browser is open." },
      { category: "Fix", text: "EB toolbar Login button now presses Tab after typing the username to advance focus to the password field before typing the password — previously the password field was sometimes skipped." },
      { category: "Fix", text: "EB toolbar URL bar: clicking it now selects all text immediately so you can type a new URL straight away. The selection highlight stays blue even when the toolbar loses window focus." },
    ],
  },
  {
    version: "1.0.803",
    date: "6 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser: opening the browser now lands directly on Instagram's homepage instead of a blank page — Create Account only needs to be pressed once and the signup starts immediately." },
      { category: "Fix", text: "Ghost Browser signup: after filling the password and clicking Next, the flow now waits for the date of birth dropdowns to actually appear (positive confirmation) before proceeding — previously it only checked that the password field had disappeared, which could exit too early mid-animation and cause the next typing to land in the still-focused password field." },
      { category: "Debug", text: "Ghost Browser signup: added live debug lines to the status panel showing the current URL and what each step detects at every transition point, making it much easier to diagnose future flow issues." },
    ],
  },
  {
    version: "1.0.802",
    date: "6 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser signup: after filling the password, the flow now waits for the password page to fully disappear before moving on to date of birth — previously it could type into the password field a second time if the page hadn't transitioned yet." },
      { category: "Fix", text: "Ghost Browser signup: Step 8 password fallback is now skipped if Step 4b already handled the password, preventing any chance of a double-type." },
      { category: "Fix", text: "Ghost Browser: Create Account button is now disabled while the browser is opening, so a second click cannot accidentally start a duplicate signup run." },
    ],
  },
  {
    version: "1.0.801",
    date: "6 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser signup: password page now detected and filled immediately after the email verification code step — Instagram's current flow shows password before date of birth, not after name/username. Previously the automation skipped the password entirely and failed silently." },
      { category: "UI", text: "Ghost Browser: Create Account, Nuke Environment, and Close Browser buttons moved to just above the Add to Equinox button. Fields are now at the top, actions at the bottom." },
      { category: "UI", text: "Ghost Browser: code-wait panel now shows a live elapsed timer (MM:SS) alongside the 5-minute timeout, so you can see how long you have left to enter the verification code." },
    ],
  },
  {
    version: "1.0.800",
    date: "6 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser signup: email field now fills correctly. The previous approach used a batch text-insert that Instagram's React forms ignored. It now types character-by-character so every keystroke fires the form's onChange and the Next button becomes active." },
      { category: "Fix", text: "Ghost Browser signup: Ctrl+A was sending Shift+A (wrong modifier). Fixed to the correct Ctrl modifier so the field clears properly before typing." },
      { category: "UI", text: "Ghost Browser: removed the Open Browser button. The new Create Account button opens the browser automatically as its first step, then runs the full signup flow — one click instead of two." },
      { category: "UI", text: "Ghost Browser: Nuke Environment button moved to directly below Create Account for quicker access." },
      { category: "UI", text: "Ghost Browser: Close Browser button now only appears when the browser is actually running." },
    ],
  },
  {
    version: "1.0.799",
    date: "6 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser signup: fixed the phone gate being silently skipped. When Instagram redirects the email signup page to /accounts/signup/phone/, the flow now detects that URL specifically and clicks 'Sign up with email' — previously the URL still contained 'signup' so the click was never triggered and the flow failed with 'Email field not found'." },
      { category: "Fix", text: "Ghost Browser Login button: password field selector now checks input[type=\"password\"] first, then input[autocomplete=\"current-password\"], falling back to input[name=\"password\"] — matches Instagram's current DOM structure." },
    ],
  },
  {
    version: "1.0.798",
    date: "6 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser auto-signup: when Instagram redirects the email signup URL to the phone gate, the flow now automatically finds and clicks the 'Sign up with email' link using a real mouse click so React's event handlers fire correctly." },
      { category: "Fix", text: "Ghost Browser auto-signup: added a second retry pass for the phone gate button in case the page was still loading when the first search ran, then falls back to the legacy emailsignup URL as a last resort." },
    ],
  },
  {
    version: "1.0.797",
    date: "6 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser auto-signup: each step in the flow now verifies the previous step actually completed before moving on. Cookie banner must be confirmed dismissed before the email field is searched. If the banner cannot be dismissed after 5 attempts the flow stops with a clear error instead of blindly continuing and failing silently on the email field." },
      { category: "Fix", text: "Ghost Browser auto-signup: 'Create new account', 'Sign up with email', and 'Next' buttons now stop the flow with a descriptive error if not found, rather than continuing and crashing later with a confusing message." },
      { category: "Fix", text: "Ghost Browser auto-signup: email field now polls up to 8 seconds before reporting not found, giving the page time to settle after the cookie banner dismissal animation." },
    ],
  },
  {
    version: "1.0.796",
    date: "6 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser cookie banner: the 'Allow all cookies' button now fires three separate click mechanisms — touch tap, mouse events, and direct element click — so the banner dismisses even when screen dimensions (DPR > 1 mobile emulation) cause the original tap to land on the banner title instead of the button." },
    ],
  },
  {
    version: "1.0.795",
    date: "6 Jun 2026",
    items: [
      { category: "Fix", text: "Ghost Browser auto-signup: cookie banner acceptance now reliably succeeds — replaced a single one-shot check (which often ran before Instagram's React had rendered the banner) with a polling loop that waits up to 7 seconds, matching the behaviour of every other browser flow in the app." },
      { category: "Fix", text: "Ghost Browser auto-signup: if the first cookie banner tap does not dismiss the overlay, the flow now automatically retries the click once before continuing." },
    ],
  },
  {
    version: "1.0.794",
    date: "6 Jun 2026",
    items: [
      { category: "Feature", text: "Ghost Browser: fully automated Instagram signup flow — open the browser, click Auto Signup, and it handles cookies, email entry, verification code, date of birth, username, and terms acceptance automatically." },
      { category: "Feature", text: "Ghost Browser: email and IMAP fields added — enter your email address, email password, and IMAP server so the app can fetch the 6-digit Instagram verification code from your inbox automatically." },
      { category: "Feature", text: "Ghost Browser: manual code fallback — if IMAP fails for any reason, type the code yourself and click Submit Code to pass it to the running signup flow." },
      { category: "Feature", text: "Ghost Browser: date of birth field added with a one-click random generator that always produces an 18+ age. Regenerates automatically on Nuke Environment." },
      { category: "Change", text: "Ghost Browser: password field moved directly below username for a more logical fill order." },
      { category: "Remove", text: "5sim SMS integration removed — account creation now uses email verification via IMAP instead of phone number SMS." },
    ],
  },
  {
    version: "1.0.793",
    date: "6 Jun 2026",
    items: [
      { category: "Feature", text: "Accounts page: the Delete action is now a compact bin icon. A new bar-chart icon opens that account's Metrics tab directly." },
      { category: "Fix", text: "Statistics page: column widths are now exact — removed the minimum-width constraint that was spreading columns across the full screen." },
      { category: "Feature", text: "Statistics page: rows for accounts that are toggled off (stopped) are now visually dimmed so active and stopped accounts are easy to tell apart." },
      { category: "Feature", text: "Metrics — Raw API Endpoint Count: two new columns show how many times each endpoint was the last one called before a status change, both for the selected account and across all accounts." },
    ],
  },
  {
    version: "1.0.792",
    date: "6 Jun 2026",
    items: [
      { category: "Fix", text: "Copy Settings: Inject Profile Browsing now includes all settings — Like %, Save Media %, Watch Stories %, View Highlights %, Comment %, and Comment Text are included when copying Follow tool and Human Session injection settings." },
      { category: "Fix", text: "Inject Browsing: Feed Posts min/max fields now accept 0, so you can set a chance of zero posts being viewed during a browsing injection." },
      { category: "Feature", text: "Account Notes: automatically stamped with the exact date and time an account was first added to Equinox. Preserved across EQX export and re-import — never overwritten." },
      { category: "Feature", text: "Statistics page: new Status column shows the account status pill alongside tool performance data." },
      { category: "Feature", text: "Metrics page: new Raw API Endpoint Count block shows every API endpoint hit with today's count and all-time total." },
    ],
  },
  {
    version: "1.0.791",
    date: "5 Jun 2026",
    items: [
      { category: "Cleanup", text: "Follow tool: Session Action Variation removed from the UI and all related backend logic cleaned up — fewer moving parts, same core follow behaviour." },
    ],
  },
  {
    version: "1.0.790",
    date: "5 Jun 2026",
    items: [
      { category: "UI", text: "Inject Browsing: Browse Before Follow and Abandon Follow moved to their own third row, keeping row 2 focused on action percentages only." },
    ],
  },
  {
    version: "1.0.789",
    date: "5 Jun 2026",
    items: [
      { category: "Fix", text: "Proxy manager: account dropdown now displays usernames correctly instead of appearing white/invisible." },
      { category: "Feature", text: "Inject Browsing: Like % — set a percentage chance to like each scrolled post during profile browse injections." },
      { category: "Feature", text: "Inject Browsing: Save Media % — set a percentage chance to save each post during profile browse injections." },
      { category: "Feature", text: "Inject Browsing: Watch Stories % — set a percentage chance to watch the target user's stories during each profile browse." },
      { category: "Feature", text: "Inject Browsing: View Highlights % — set a percentage chance to view the target user's highlights during each profile browse." },
      { category: "Feature", text: "Inject Browsing: Comment % — set a percentage chance to leave a comment on a post during profile browse; supports spintax for varied comments." },
      { category: "UI", text: "Inject Browsing settings are now all on a single compact row (Browse Before Follow, Abandon Follow, and all new % fields inline)." },
      { category: "UI", text: "Inject Search and Inject Suggested Users are now on their own row, separate from Inject Browsing." },
    ],
  },
  {
    version: "1.0.788",
    date: "5 Jun 2026",
    items: [
      { category: "Feature", text: "Ghost Browser: 5sim SMS integration added — enter your API token, pick a country, get a phone number, and receive the Instagram verification code directly in the panel." },
      { category: "Feature", text: "Ghost Browser: Bio Spin field added — write a spintax bio template and paste it directly into the browser." },
      { category: "Feature", text: "Ghost Browser: Add to Equinox button — after creating an account in the Ghost Browser, save the username and password to Equinox in one click." },
      { category: "UI", text: "Ghost Browser: Start button renamed to Open Browser." },
      { category: "UI", text: "Ghost Browser: Fingerprint section is now collapsed by default; click + to expand it." },
      { category: "UI", text: "Ghost Browser: Proxy dropdown no longer repeats the host:port when a proxy name is already shown." },
      { category: "UI", text: "Ghost Browser: Removed the 'No proxy — real IP exposed' warning banner." },
      { category: "UI", text: "Accounts page: embedded browser icon is slightly larger for easier clicking." },
      { category: "UI", text: "Embedded browser windows now open maximised." },
    ],
  },
  {
    version: "1.0.787",
    date: "5 Jun 2026",
    items: [
      { category: "Fix", text: "Stats page: Human Session toggle now correctly shows and syncs the on/off state for each account." },
      { category: "Feature", text: "Stats page: Reposts column added to the Tool Performance table." },
      { category: "Feature", text: "Stats page Metrics tab: added Total API Calls, ABD Dismissed, Captchas Hit, and Bans Detected data points to the Account Health section." },
      { category: "Feature", text: "Stats page Metrics tab: Human Session Cycles counter added, and pie charts now show only action-type stats (follows, unfollows, DMs, likes, comments, story views, reposts)." },
      { category: "UI", text: "Column width inputs across all pages: minimum width removed — columns can now be made as narrow as needed." },
      { category: "Tracking", text: "Repost, captcha, and ban events now increment their own stat counters so they appear in the Metrics tab." },
    ],
  },
  {
    version: "1.0.786",
    date: "5 Jun 2026",
    items: [
      { category: "Fix", text: "Embedded browser window no longer overlaps the Windows taskbar on open — it now fills the available work area exactly as a normal browser would, with the title bar always visible and closeable." },
      { category: "UI", text: "Statistics page: all data columns are now centre-aligned. The Account Name column remains left-aligned." },
      { category: "UI", text: "Statistics page: 'Human Session Tool' column renamed to 'Human Session'." },
      { category: "Feature", text: "Statistics page now has two tabs — Tool Performance (existing table) and Metrics (new)." },
      { category: "Feature", text: "Metrics tab: select any account from a dropdown to view today's and lifetime activity as interactive pie charts, plus a grid of data-point cards for every tracked action type." },
    ],
  },
  {
    version: "1.0.785",
    date: "5 Jun 2026",
    items: [
      { category: "UI", text: "Accounts page: browser button now shows a monitor icon instead of a globe icon." },
      { category: "Fix", text: "Deleting an account now automatically removes its linked proxy from the proxy manager if no other accounts share it." },
      { category: "Fix", text: "Proxy ping now uses a direct TCP connection test — dead proxies correctly show as offline instead of falsely reporting alive." },
      { category: "Fix", text: "Statistics page: Human Session Tool toggle is now visible for all accounts." },
      { category: "Fix", text: "Ghost Browser: pre-signup warm-up section removed — the browser opens cleanly without auto-running warm-up actions." },
      { category: "UI", text: "Device Identity dropdown is now one row tall with the UA string truncated to fit, instead of wrapping across multiple lines." },
      { category: "UI", text: "Settings: My Account tab is now the first tab." },
      { category: "UI", text: "Settings › My Account: subscription plan cards are now always visible regardless of login status." },
      { category: "UI", text: "Admin panel: admin accounts now show ∞ for account slots instead of a number." },
      { category: "Feature", text: "Accounts page › Actions: new Flag Accounts option marks selected accounts with a red flag icon. Flag / Unflag toggles automatically based on current state." },
    ],
  },
  {
    version: "1.0.784",
    date: "5 Jun 2026",
    items: [
      { category: "Fix", text: "Profile Sync section is no longer hidden when 'Account Details, Security & Email Validation' is collapsed — it now lives in its own always-accessible section at the bottom of Account Settings." },
    ],
  },
  {
    version: "1.0.783",
    date: "5 Jun 2026",
    items: [
      { category: "UI", text: "Activity log detail messages are cleaner: 'Visited profile', 'Scrolled N posts', 'Opened post from profile' — the username is already shown in the Target column so it is no longer repeated in the detail." },
      { category: "UI", text: "Accounts page: Status and TrustScore column headers and badges are now center-aligned." },
      { category: "UI", text: "Accounts page Actions column: removed the Config link. Browser button is now a globe icon." },
      { category: "UI", text: "Dashboard activity table: Action, Target, and TrustScore column headers and cells are now center-aligned." },
    ],
  },
  {
    version: "1.0.782",
    date: "5 Jun 2026",
    items: [
      { category: "Fix", text: "Randomise Timing in Copy Settings now correctly staggers all accounts using random offsets within your Execute Every Min–Max range, regardless of whether Start/Stop is also being copied. Running tools are cold-restarted with their stagger delay immediately." },
      { category: "Fix", text: "Min/Max field pairs (Execute Every, Inject Profile Browsing, Browse Before Follow, Abandon Follow, etc.) now work intuitively: increasing min auto-bumps max up, decreasing max auto-bumps min down — no more getting stuck." },
      { category: "Fix", text: "Inject Profile Browsing sub-settings (Feed Posts, Open Post%, Browse Before Follow, Abandon Follow) are now indented directly below the Inject Profile Browsing toggle instead of being left-aligned." },
      { category: "Fix", text: "Stop Tool if Blocked no longer triggers on Automated Behaviour Detected errors. It now only fires for real Action Blocked or We restrict certain actions prompts from Instagram." },
    ],
  },
  {
    version: "1.0.781",
    date: "5 Jun 2026",
    items: [
      { category: "Fix", text: "Follow Tool: Inject GetSuggestedUsers now fires correctly. Injection count is pre-calculated at the start of each session as a percentage of Users Per Session — so if you set 30% and the session targets 10 users, exactly 3 of those 10 will have the injection fire." },
      { category: "Fix", text: "Follow Tool: Same session-level percentage logic now applies to Inject Search and Browse Before Follow — all injections are pre-distributed across the session rather than rolling dice before every individual follow." },
      { category: "Fix", text: "Follow Tool: getSuggestedUsers failures now log a warning in the activity log instead of being swallowed silently, so you can see if the call is failing." },
      { category: "UI", text: "Follow Tool injection settings: Inject Profile Browsing checkbox and percentage are now on the same row as Inject Suggested Users. Feed Posts, Open Post%, Browse Before Follow, and Abandon Follow sub-settings stack vertically below." },
      { category: "Fix", text: "Embedded browser toolbar: fixed a second scrollbar appearing next to the Instagram page scrollbar. The toolbar is now locked to its 92px height with overflow hidden." },
    ],
  },
  {
    version: "1.0.780",
    date: "5 Jun 2026",
    items: [
      { category: "Fix", text: "Statistics page: Human Session Tool is now the only column with an on/off toggle. Follow, Unfollow, and DMs columns no longer show toggle buttons — they show counts only." },
      { category: "Improvement", text: "Statistics page: Open EB and TrustScore columns are now draggable and reorderable just like all other columns. Use the Columns panel to move them anywhere in the table." },
      { category: "Improvement", text: "Statistics page: TrustScore column width is now adjustable in the Columns panel alongside all other columns." },
      { category: "Fix", text: "Export Profiles: accounts whose proxy is assigned via the Proxy Manager (using a proxyId link) now correctly export the proxy IP and port instead of leaving that field blank." },
      { category: "Fix", text: "Dashboard startup log now reads 'Equinox started: 05 Jun 2026, 08:43:09' with a colon separator instead of a dash." },
      { category: "Improvement", text: "README & FAQ updated to reflect the current two-stage Jarvee verify flow, Human Session Tool description, data storage details, and correct update instructions." },
    ],
  },
  {
    version: "1.0.779",
    date: "4 Jun 2026",
    items: [
      { category: "Fix", text: "Inject Profile Browsing, Inject Suggested Users, and Inject Search percentages now default to 1% when no value has been saved — previously they defaulted to 30–60%, causing them to fire far more often than expected. All injection percentages are per-user: a 5% setting means each individual user has a 5% chance of triggering the action, never a batch-level toggle." },
      { category: "UI", text: "Follow Tool injection settings (Inject Search, Inject Suggested Users, Inject Profile Browsing) are now all on a single row instead of being stacked across two rows." },
      { category: "Fix", text: "Embedded browser windows now open maximised. Showing the window before maximising prevents the known Windows bug where the Chromium window covers the taskbar." },
      { category: "Fix", text: "Export API Calls: Human Session operations (GetReelsTray, NotificationsBadge, ViewTimelineFeed, LauncherSync, etc.) now correctly show 'Human Session Tool' in the Operation Name column instead of 'Emulation'." },
      { category: "Fix", text: "Export API Calls: Source column now shows 'Equinox' for all engine-generated calls and 'HikerAPI' for HikerAPI-sourced data, replacing the previous verbose internal source names." },
      { category: "Fix", text: "Statistics page: Human Session Tool column now shows only the on/off toggle — no counts. Column renamed from 'Human Sessions' to 'Human Session Tool'." },
      { category: "Fix", text: "Statistics page: adjusting a column width in the Columns panel no longer causes other columns to expand or shift. Each column width is now independent." },
    ],
  },
  {
    version: "1.0.778",
    date: "4 Jun 2026",
    items: [
      { category: "Fix", text: "Embedded browser window now opens at its default 1280×820 size instead of filling the screen. Removed the automatic maximise behaviour that was covering the whole display." },
      { category: "Fix", text: "2FA toolbar button: digit typing slowed to 200–600 ms per digit (was 50–230 ms) to better match the speed of a real person reading and entering a 6-digit code." },
      { category: "Fix", text: "2FA toolbar button: field detection now retries up to 10 times with 500 ms gaps so it finds the input even when Instagram's 2FA page is still rendering. Previously it tried once and gave up silently if the input wasn't ready." },
      { category: "Fix", text: "Accounts → Actions → Remove Proxies now correctly unlinks the proxy by clearing the proxy ID, not just clearing the host/port fields. Previously the account remained linked to the proxy in the database." },
      { category: "Fix", text: "Accounts → Actions → Ungroup Accounts now shows accounts under 'No Group Assigned' (was 'Ungrouped') to match the rest of the app terminology." },
    ],
  },
  {
    version: "1.0.777",
    date: "4 Jun 2026",
    items: [
      { category: "Fix", text: "Phone number toolbar button now auto-detects the phone field on the page via CDP (clicking it, selecting all, deleting, then typing digit by digit with human timing), rather than requiring you to click the field yourself first. Falls back to the previously-focused field if no phone input is found." },
      { category: "Fix", text: "2FA toolbar button: detection now uses a much wider set of selectors and a smart fallback — if exactly one visible text input exists on the page it uses that, removing the need to manually click the field first." },
      { category: "Fix", text: "Typing speed variance widened: base delay is now 80–280 ms per character (was 60–160 ms) with an 8% chance of a 400–1000 ms thinking pause between characters (was 3% / 300–800 ms)." },
      { category: "Fix", text: "Proxy Manager: clicking the ACCOUNTS column header now sorts proxies by number of accounts attached (fewest first, click again for most first). The column header was missing from the sortable set." },
      { category: "Fix", text: "Account settings group dropdown: removed the 'Clear (no group)' option. Clearing the text field directly unassigns the group. All group options now use the same bold font as the input placeholder." },
      { category: "Fix", text: "Embedded browser window no longer overlaps the Windows taskbar. It now uses the display work area to set its bounds instead of calling maximize(), which could cover the taskbar in some Windows configurations." },
    ],
  },
  {
    version: "1.0.776",
    date: "4 Jun 2026",
    items: [
      { category: "Fix", text: "Login toolbar button: after filling the password, a Tab key is now sent to blur the field and trigger Instagram's form validation — this enables the blue Log In button so it can be clicked automatically. Previously the button stayed disabled and had to be pressed manually." },
      { category: "Fix", text: "2FA toolbar button: typing speed now varies between 50–230 ms per digit (was a narrow 40–100 ms that sounded robotic). A 700–1500 ms natural pause is added after the last digit before the Submit button is clicked, matching the realistic human behaviour of checking the code before confirming." },
    ],
  },
  {
    version: "1.0.775",
    date: "4 Jun 2026",
    items: [
      { category: "Fix", text: "Login flagging: the 2FA toolbar button now fills the TOTP code using CDP mouse + keyboard events (isTrusted = true) instead of JavaScript value injection (isTrusted = false). The old approach set the field value and fired synthetic events from JS — Instagram detects these as bot input. The button now clicks the field via CDP, types each digit individually with human timing, then clicks the Submit button via CDP." },
    ],
  },
  {
    version: "1.0.774",
    date: "4 Jun 2026",
    items: [
      { category: "Fix", text: "Login flagging: all form filling now types character-by-character with randomised 60–160 ms inter-key delays and occasional natural pauses, instead of delivering the entire username or password as one instant paste event. Instagram's keystroke-timing analyser could distinguish a single bulk insert from real typing regardless of isTrusted — this removes that signal from every login path (auto-fill on navigate, verify flow, and the Login toolbar button)." },
      { category: "Fix", text: "2FA code entry now types each digit individually at 40–100 ms per digit, matching the speed a real person taps a 6-digit code on a phone keyboard." },
    ],
  },
  {
    version: "1.0.773",
    date: "4 Jun 2026",
    items: [
      { category: "Fix", text: "Login flagging: all form filling in the embedded browser now uses OS-level CDP input events (isTrusted = true) instead of JavaScript-injected events (isTrusted = false). This applies to the verify flow, the EB auto-fill on navigation, and the Login toolbar button." },
      { category: "Fix", text: "Login flagging: 2FA code entry across all fill paths (verify, auto-fill on navigation, toolbar button) now uses CDP trusted events. JS-injected events are always isTrusted = false — Instagram treats them as bot input regardless of typing speed." },
      { category: "Fix", text: "Login flagging: the Phone, Email, and Email Pass toolbar buttons now type into fields using CDP Input.insertText (isTrusted = true) instead of JavaScript value injection." },
      { category: "Fix", text: "Login flagging: added the --disable-blink-features=AutomationControlled Chromium flag. Without this, Electron sets navigator.webdriver = true at the browser engine level before any page loads — JavaScript overrides cannot fully mask it. This flag prevents it from being set in the first place." },
      { category: "Fix", text: "Login flagging: the page-level auto-fill script that fires on every navigation no longer injects form values via JavaScript (isTrusted = false). The CDP-based fill now handles all auto-fill, with the page script retained only for focus tracking and cookie banner detection." },
    ],
  },
  {
    version: "1.0.772",
    date: "4 Jun 2026",
    items: [
      { category: "Fix", text: "Browser fingerprinting: the app now sends the real Chrome build number (e.g. 131.0.6778.260) in Client Hints headers and the JS fingerprint API instead of the fake '131.0.0.0' that no real Chrome ever produces. Instagram checks this value and the fake patch number was an immediate bot signal." },
      { category: "Fix", text: "Browser fingerprinting: the Client Hints GREASE brand token is now version-aware — Chrome 128 and later correctly sends ' Not A;Brand' (with leading space) instead of 'Not/A)Brand'. Sending the same wrong brand across every account was a cross-account correlation Instagram could detect." },
      { category: "Fix", text: "Browser fingerprinting: the Android OS version in Client Hints now matches the version declared in the User-Agent string. The hidden verify window was always sending Android 10 even for accounts using Android 14 or 15 User-Agents, creating a mismatch Instagram fingerprints." },
      { category: "Fix", text: "Browser fingerprinting: the device model field in Client Hints is now extracted from the User-Agent string and included in the Sec-CH-UA-Model header, matching what a real device would send." },
    ],
  },
  {
    version: "1.0.771",
    date: "4 Jun 2026",
    items: [
      { category: "Fix", text: "Browser fingerprinting: corrected the Client Hints brand token to 'Not/A)Brand' (the format real Chrome 108+ sends) in all three locations — the main browser window, the hidden verify window, and the injected fingerprint script. The old tokens ('Not_A Brand', 'Not-A.Brand' with version 99) were detectable as non-genuine Chrome and could contribute to Instagram flagging logins." },
    ],
  },
  {
    version: "1.0.770",
    date: "4 Jun 2026",
    items: [
      { category: "Fix", text: "Login: after 2FA is accepted, Instagram now redirects through a cookie-consent error page — the app detects this, navigates to instagram.com, confirms the session cookie is present, and completes the login. The browser window no longer gets stuck showing 'Sorry, something went wrong'." },
    ],
  },
  {
    version: "1.0.769",
    date: "4 Jun 2026",
    items: [
      { category: "Fix", text: "Login: when the browser opens already on the consent challenge page (consent/?flow=user_cookie_choice_v2), it now navigates to the login form and re-submits credentials so Instagram can show the 2FA/TOTP entry screen." },
    ],
  },
  {
    version: "1.0.768",
    date: "4 Jun 2026",
    items: [
      { category: "Fix", text: "Login: when Instagram redirects through a cookie-consent error page after login, the app now automatically navigates to the 2FA entry screen — same as tapping 'Try another way' → Authenticator App on mobile." },
      { category: "Fix", text: "Login: the cookie-consent challenge page is no longer incorrectly treated as a successful login." },
      { category: "Fix", text: "Browser: if the embedded browser is left parked on the consent challenge error page, it now automatically navigates back to instagram.com." },
    ],
  },
  {
    version: "1.0.767",
    date: "4 Jun 2026",
    items: [
      { category: "Feature", text: "My Account: you can now upload a profile picture — click your avatar to pick an image, stored locally on your device." },
      { category: "Improvement", text: "User Management: plan selection now uses radio buttons showing all tiers with slots and pricing at a glance — in both Add User and Edit User forms." },
      { category: "Improvement", text: "Bulk Account Import moved into Settings under a dedicated Import tab — removed from the sidebar." },
      { category: "Improvement", text: "Proxy Manager accounts column now shows valid/total counts (green for valid, grey for total)." },
    ],
  },
  {
    version: "1.0.766",
    date: "4 Jun 2026",
    items: [
      { category: "Fix", text: "Inject Profile Browsing no longer visits the same profile twice — the pre-follow general browse has been removed; the feature now fires once after a successful follow." },
      { category: "Fix", text: "Emulation API calls now export with the label 'Emulation' instead of 'Human Session Emulation' in the API calls CSV." },
      { category: "Fix", text: "Account Settings: API User Agent picker now shows the full user agent string without truncation — removed the duplicate small string below the picker." },
      { category: "Improvement", text: "View Timeline Feed layout: title and main settings on Row 1, Like settings on Row 2, Click on Post% on Row 3." },
    ],
  },
  {
    version: "1.0.765",
    date: "4 Jun 2026",
    items: [
      { category: "Fix", text: "Inject Profile Browsing now fires before every follow including the first — previously it was skipped for follow #1, so sessions configured to do 1 follow per run never browsed at all." },
    ],
  },
  {
    version: "1.0.764",
    date: "3 Jun 2026",
    items: [
      { category: "Fix", text: "HikerAPI hashtag scraping now finds users again — added /top endpoint variants (recent cache is often empty for niche tags) and fixed the v2 endpoint parameter name. Previously all hashtag rounds returned 0 users." },
      { category: "Fix", text: "HikerAPI token status no longer shows Failed incorrectly — the test now distinguishes between a bad token and a temporary service/cache miss from HikerAPI's servers." },
      { category: "Fix", text: "Exec Order and Skip Chance % fields in all Emulation section rows (View Timeline Feed, Human Session, Check Stories, Check DMs, Repost) are now neatly stacked on the right side of each row — matching the embedded tool header layout." },
    ],
  },
  {
    version: "1.0.762",
    date: "3 Jun 2026",
    items: [
      { category: "Fix", text: "HikerAPI token now shows Connected instead of Failed — the test was checking the wrong field in HikerAPI's response after they changed their response format. The fix covers all user lookup methods (username resolve, profile stats, profile info) which were also silently returning nothing." },
      { category: "Fix", text: "Execution Order and Skip Chance fields in the Human Session Tool embedded Follow, Unfollow, and Contact tool headers are now perfectly right-aligned — previously the different label lengths (Execution Order vs Skip Chance %) caused the input boxes to shift." },
    ],
  },
  {
    version: "1.0.761",
    date: "3 Jun 2026",
    items: [
      { category: "Fix", text: "API Limits & Control — Max Calls and Max (ms) fields now let you type freely; the minimum constraint is only enforced when you leave the field, not on every keystroke." },
      { category: "Fix", text: "Hashtag scraping in the Follow tool now correctly calls the v1/hashtag endpoint on HikerAPI. Previously the code called v2 and tried to parse a sections structure that v2 does not return, so no users were ever extracted." },
      { category: "Improvement", text: "Dash, Browser, and Copy Settings buttons are now positioned immediately next to Session Log in the tab bar instead of being pushed to the far right." },
      { category: "Improvement", text: "Human Session tab renamed to Human Session Tool." },
    ],
  },
  {
    version: "1.0.760",
    date: "3 Jun 2026",
    items: [
      { category: "Fix", text: "API Limits & Control — Min fields no longer get clamped to the Max value while typing, making it possible to freely type a higher Min and then raise Max independently." },
      { category: "New", text: "Copy Settings dialog now has a search box on the settings side so you can filter down to a specific setting group by name." },
      { category: "Improvement", text: "Dash, Browser, and Copy Settings are now on the same row as the Account Settings / Human Session / Session Log tabs — the top navigation no longer has any text buttons." },
      { category: "Improvement", text: "Removed the redundant Accounts back button from the top of the account detail page." },
    ],
  },
  {
    version: "1.0.759",
    date: "3 Jun 2026",
    items: [
      { category: "Fix", text: "Hashtag sources no longer get marked as exhausted mid-session when a page returns users that are all filtered by dedup — the cursor is already advanced so the next round now correctly fetches the next page instead of stopping." },
      { category: "Fix", text: "Inject Profile Browsing Before Follow now correctly uses its own dedicated percentage (Before Follow %) instead of the general Inject Profile Browsing percentage." },
      { category: "New", text: "Abandon Follow after browsing is now fully implemented — when enabled, the engine will skip the follow call after visiting a profile at the configured percentage, matching the UI option that was previously ignored." },
    ],
  },
  {
    version: "1.0.758",
    date: "3 Jun 2026",
    items: [
      { category: "New", text: "Human Session Tool actions (View Timeline Feed, Human Session, Check Stories, Check DMs, Repost, Open Instagram Calls) are now grouped under a single Emulation panel with a cyan top border." },
      { category: "Improvement", text: "Execution Order and Skip Chance controls now appear inline beside each action's checkbox and label instead of floating to the right." },
      { category: "Improvement", text: "Force Emulation renamed to Open Instagram Calls throughout the tool and its copy settings." },
      { category: "Improvement", text: "Human Session Tool panel title simplified to Human Session Tool." },
      { category: "Improvement", text: "Account Import sidebar icon redesigned to a person with a bold import arrow." },
    ],
  },
  {
    version: "1.0.757",
    date: "3 Jun 2026",
    items: [
      { category: "Fix", text: "Profile browsing in the Follow tool now correctly fires at the configured percentage — it was firing on every single follow regardless of the probability setting." },
      { category: "Fix", text: "Profile visit API call now includes the correct navigation context parameter, matching what the real Instagram app sends." },
    ],
  },
  {
    version: "1.0.756",
    date: "3 Jun 2026",
    items: [
      { category: "Fix", text: "CAPTCHA images on the suspended/challenge page now load correctly in the embedded browser — Instagram's CSP header was blocking them." },
      { category: "Fix", text: "Login screen 'Equinox' title now matches the sidebar style with the cyan 'nox' ending." },
      { category: "Fix", text: "Logo and title on the login screen are now closer together." },
      { category: "Fix", text: "Save login checkbox label shortened." },
    ],
  },
  {
    version: "1.0.755",
    date: "3 Jun 2026",
    items: [
      { category: "Fix", text: "White screen on startup fixed — a missing import caused the app to crash before showing anything." },
      { category: "Fix", text: "Login screen now shows a white background with black text and borders regardless of theme setting." },
      { category: "Fix", text: "Login screen now uses the correct Equinox logo (same as the top-left of the sidebar)." },
    ],
  },
  {
    version: "1.0.754",
    date: "3 Jun 2026",
    items: [
      { category: "New", text: "Splash screen now shows the Equinox logo and blocks access until you sign in — no part of the software is reachable without valid credentials." },
      { category: "New", text: "Save Login checkbox on the sign-in screen — tick it once and Equinox will sign you in automatically every time it restarts." },
      { category: "New", text: "My Account now shows all subscription plans as radio buttons with your current plan highlighted; non-current plans show their monthly price and a 'coming soon' upgrade note." },
      { category: "New", text: "Subscription expiry date now shown in My Account — turns amber when within 7 days and red when expired." },
      { category: "New", text: "Admin owners can now manage all users directly from Settings → My Account: create accounts, set plan tiers, account slot limits, expiry dates, passwords, and toggle active status." },
      { category: "Fix", text: "Statistics page group banners now match the Accounts page style — same background, font weight, and icon-upload button." },
    ],
  },
  {
    version: "1.0.753",
    date: "3 Jun 2026",
    items: [
      { category: "Fix", text: "Browser button no longer occasionally opens two browser windows when clicked quickly — duplicate clicks are now ignored until the first window finishes opening." },
      { category: "Fix", text: "Editing an account's label no longer clears its group assignment when the page loaded with cached data." },
      { category: "Fix", text: "TrustScore badge picker now opens upward when the account row is near the bottom of the screen." },
    ],
  },
  {
    version: "1.0.752",
    date: "3 Jun 2026",
    items: [
      { category: "Fix", text: "Jarvee import: Instagram password now correctly extracted when Jarvee stores the same password for both Instagram and the recovery email." },
    ],
  },
  {
    version: "1.0.751",
    date: "3 Jun 2026",
    items: [
      { category: "Fix", text: "Jarvee binary import: passwords that are base64-encoded in the file now decode correctly instead of importing as raw garbled text." },
      { category: "Fix", text: "Jarvee binary import: 2FA secret now reliably extracted even when it appears after the proxy block." },
      { category: "Fix", text: "Jarvee binary import: duplicate account no longer created for files with a single account entry." },
      { category: "Fix", text: "Valid account status badge no longer shows a misleading 'Login Required' tooltip." },
      { category: "Fix", text: "Follow rate estimate now correctly reflects your Execute Every interval and Users Per Session settings." },
    ],
  },
  {
    version: "1.0.750",
    date: "3 Jun 2026",
    items: [
      { category: "New", text: "My Account tab in Settings: sign in with your Equinox license credentials to view your plan tier and account slot limit." },
      { category: "New", text: "Account limits: attempting to add accounts beyond your plan limit now shows an upgrade prompt instead of silently failing." },
      { category: "New", text: "Force Emulation: added BatchFetchWeb and AttributionLaunch to the startup call sequence — two API calls that real Instagram sends on every app open." },
      { category: "Fix", text: "Session Actions export: human session calls (feed view, DM check, story check) now correctly show 'Human Session Emulation' as their source instead of 'Follow Tool'." },
    ],
  },
  {
    version: "1.0.749",
    date: "3 Jun 2026",
    items: [
      { category: "Fix", text: "Proxy Manager: STATUS and TRUSTSCORE columns are no longer duplicated — they now appear only in the per-account sub-panel, not as separate main-row columns." },
      { category: "Fix", text: "Proxy Manager: ACCOUNTS column removed from main row — account count and per-account status/trust score are in the sub-panel below each proxy." },
      { category: "Fix", text: "Proxy Manager: PROXY STATUS column header now stays on one line." },
      { category: "Fix", text: "Embedded browser: challenge pages (Automated behaviour detected) now load correctly — the challenge screen shows so you can click the dismiss button, instead of showing a Facebook error page." },
      { category: "Fix", text: "Embedded browser: browser panel now opens instantly when clicking the Browser button, instead of taking 5 seconds." },
    ],
  },
  {
    version: "1.0.746",
    date: "3 Jun 2026",
    items: [
      { category: "Fix", text: "Accounts: deleting an account now removes it from the list immediately instead of taking up to 30 seconds — the browser session now closes without blocking the UI update." },
      { category: "Fix", text: "Browser panel: opening the embedded browser now always shows the correct URL in the address bar and displays the current page immediately, even when reconnecting to an existing session already on a challenge page." },
      { category: "Fix", text: "Proxy Manager: Status and TrustScore column headers now appear in the account sub-panel when those columns are enabled." },
      { category: "Improvement", text: "Proxy Manager: column headers now show a grab cursor when hovered, making drag-to-reorder easier to discover." },
    ],
  },
  {
    version: "1.0.745",
    date: "3 Jun 2026",
    items: [
      { category: "Fix", text: "Browser panel: accounts with verification challenges (captcha, automated behaviour detected) now show a visible error page in the embedded browser instead of a blank white screen — the challenge URL is displayed so you can open it in your own browser to resolve it." },
      { category: "Fix", text: "Copy Settings: Randomise Timing now correctly staggers when accounts are started via Copy Settings — previously all accounts started instantly at the same time instead of being spread across the delay window." },
    ],
  },
  {
    version: "1.0.744",
    date: "3 Jun 2026",
    items: [
      { category: "Fix", text: "Accounts: clicking Browser now responds immediately — reduced proxy check timeout and added instant server acknowledgment, eliminating the 5-10 second delay before the browser panel appeared." },
      { category: "Fix", text: "Human Session copy settings: Follow Tool Start / Stop state was missing from the Embedded Tool States section — it now appears and copies correctly to other accounts." },
      { category: "Fix", text: "Accounts: Export EQX was silently failing due to a scoping bug — fixed so single and bulk exports now work correctly." },
    ],
  },
  {
    version: "1.0.743",
    date: "3 Jun 2026",
    items: [
      { category: "New", text: "Proxy Manager: each assigned account now shows its Status pill and TrustScore badge directly in the account sub-panel." },
      { category: "New", text: "Proxy Manager: Ping All button moved to the top toolbar, next to Import Proxies, for quicker access." },
      { category: "Fix", text: "Proxy Manager: Split Now no longer freezes the button if multiple accounts are assigned at once — fixed a race condition in the mutation." },
      { category: "Fix", text: "EQX import: accounts imported with a linked proxy now auto-create or re-link the proxy entry, instead of always importing as unassigned." },
    ],
  },
  {
    version: "1.0.742",
    date: "2 Jun 2026",
    items: [
      { category: "New", text: "Target Sources: added a Clear All button — removes every source from the current tool in one click." },
      { category: "New", text: "Target Sources: replaced the Hashtag / Followers of Account dropdown with inline tabs for faster switching." },
      { category: "New", text: "Copy Settings: added a Clear Sources First option — wipes all existing sources from destination profiles before copying, so they end up with exactly the source's list rather than a merged one." },
    ],
  },
  {
    version: "1.0.741",
    date: "2 Jun 2026",
    items: [
      { category: "Fix", text: "Copy Settings: Select All now expands all sections and ticks parent checkboxes, not just the hidden sub-settings." },
      { category: "Fix", text: "Copy Settings: tools that are already running are no longer interrupted when you copy settings — the new values apply on their next cycle. Only tools being turned on (from off) restart immediately." },
      { category: "Fix", text: "Copy Settings: Randomise Timing now correctly staggers tools — each account waits a random time from the Execute Every range before starting, instead of all starting at once." },
      { category: "Fix", text: "Inject GetSuggestedUsers: the Max value can now be lowered below the current Min — Min follows it down automatically." },
      { category: "Fix", text: "Follow Tool, Unfollow Tool and Contact Tool icons in the Human Session panel are now twice as large." },
      { category: "Fix", text: "Users/hr and users/day estimates for the Follow and Unfollow tools now account for the Skip Chance setting — a 50% skip chance halves the shown estimate." },
    ],
  },
  {
    version: "1.0.740",
    date: "2 Jun 2026",
    items: [
      { category: "Fix", text: "Copy Settings dialog: every sub-setting section is now collapsed by default — click the row to expand and select individual options. Avoids accidentally copying everything." },
      { category: "Fix", text: "Copy Settings labels cleaned up — removed all the redundant bracket descriptions from every option in every tool's copy dialog." },
      { category: "Fix", text: "Follow Sources moved into the Follow Tool Settings section of the Human Session copy dialog." },
    ],
  },
  {
    version: "1.0.739",
    date: "2 Jun 2026",
    items: [
      { category: "Fix", text: "Follow Tool Copy Settings now includes the Skip Indian Users filter and all Browse Before Follow sub-settings (Before Follow %, Abandon Follow, Abandon %)." },
      { category: "New", text: "Human Session Copy Settings now has dedicated Follow Tool, Unfollow Tool, and Contact Tool sections — every setting for each tool can be copied independently in one dialog." },
    ],
  },
  {
    version: "1.0.737",
    date: "2 Jun 2026",
    items: [
      { category: "New", text: "Browse Before Follow now has an Abandon Follow X–Y% sub-setting — after browsing a profile, the bot skips the follow a random percentage of the time so Instagram sees profile visits that don't always lead to a follow." },
    ],
  },
  {
    version: "1.0.736",
    date: "2 Jun 2026",
    items: [
      { category: "Fix", text: "Dashboard activity log no longer shows raw Instagram API calls — only tool actions (Follow, Unfollow, DM, Contact, etc.) appear in the ACTION and DETAIL columns." },
      { category: "Fix", text: "Test Timing result now appears to the right of the button instead of below it, and shows a random sample timing drawn from your configured range each time you click." },
    ],
  },
  {
    version: "1.0.748",
    date: "3 Jun 2026",
    items: [
      { category: "Fix", text: "Proxy Manager: STATUS and TRUSTSCORE columns now appear in the main row alongside PROXY, TYPE, USERNAME, PASSWORD — account statuses are visible inline without expanding the sub-panel." },
      { category: "Change", text: "Proxy Manager: all column headers are now uppercase. The proxy ping column is now called PROXY STATUS; the account status column is now called STATUS." },
      { category: "Fix", text: "Ping All now tests proxies against instagram.com directly — fixes false Dead results caused by the previous test target (httpbin.org) being unreachable through some proxies." },
      { category: "Fix", text: "Dashboard activity log export now shows 'Account @username exported' instead of including the filename." },
      { category: "Change", text: "Dashboard header now reads 'Equinox started at:' instead of 'Equinox started —'." },
      { category: "Fix", text: "Embedded browser: scraping_warning redirect loop that caused a blank page for imported accounts — the interceptor now correctly passes the challenge-completion flag so Instagram loads the home feed instead of looping." },
    ],
  },
  {
    version: "1.0.747",
    date: "3 Jun 2026",
    items: [
      { category: "Fix", text: "Verifying more than 4 accounts simultaneously no longer crashes the software — a queue limit now rejects excess verify requests with a clear message instead of hanging." },
      { category: "Fix", text: "Embedded browser (Electron) no longer shows a blank screen when reopening an account — the URL bar is seeded immediately and the page is reloaded if it failed to render." },
      { category: "Change", text: "Status indicator in the bottom-left corner changed from amber Developing to green Operational." },
      { category: "Change", text: "AI Image Generator card removed from Settings → Security — the button was already removed from the toolbar in an earlier update." },
      { category: "Change", text: "Import Profiles button in the Actions menu: removed the upload icon on the left, added a cyan arrow on the right." },
      { category: "Fix", text: "Proxy Manager column headers no longer show a grab cursor — drag-to-reorder cursor removed as requested." },
    ],
  },
  {
    version: "1.0.735",
    date: "2 Jun 2026",
    items: [
      { category: "Fix", text: "EQX export now correctly embeds the account's TrustScore badge — the badge was always missing from exported files because the server was reading the query parameter from the wrong scope." },
      { category: "Fix", text: "EQX import now correctly restores the TrustScore badge that was saved in the file." },
    ],
  },
  {
    version: "1.0.734",
    date: "2 Jun 2026",
    items: [
      { category: "Fix", text: "Activity log no longer shows Started / Complete entries for sub-tools (Follow, Unfollow, Contact, DM) — only the Human Session Emulation tool logs session start and complete." },
      { category: "Fix", text: "Session order line removed from the activity log detail column." },
      { category: "Fix", text: "Started badge now shows a thumbs-up icon instead of the play arrow." },
      { category: "Fix", text: "Export API Calls now correctly labels the Operation Name column with the responsible tool (Human Session Emulation, Follow Tool, Unfollow Tool, Contact Tool) instead of copying the API Call column." },
    ],
  },
  {
    version: "1.0.733",
    date: "2 Jun 2026",
    items: [
      { category: "Fix", text: "Trust Score level is now included in EQX exports and restored automatically on import — no more resetting the badge after moving accounts." },
      { category: "Fix", text: "Timezone fallback pool no longer includes Europe/Berlin — random fallback now stays within US timezones and Europe/London only." },
      { category: "Fix", text: "Export API Calls now includes a dedicated 'API Call' column showing the raw Instagram endpoint (e.g. AutoFollow, UnfollowUser) alongside the 'Operation Name' column showing the responsible tool." },
      { category: "Fix", text: "Human Session execution order is now shown in the activity log so you can see exactly which actions ran and in what sequence each session." },
    ],
  },
  {
    version: "1.0.738",
    date: "2 Jun 2026",
    items: [
      { category: "Improvement", text: "All min/max delay, process, and rate limit pairs now clamp automatically — setting the minimum above the maximum (or vice versa) corrects the other value instantly." },
      { category: "Improvement", text: "Browser Fingerprint Preview in Account Settings is now collapsed by default — click to expand and see what the Leak Tool measures." },
      { category: "Improvement", text: "Account Details, Security, and Email Validation cards in Account Settings are now collapsed by default — click the header to expand them." },
    ],
  },
  {
    version: "1.0.732",
    date: "2 Jun 2026",
    items: [
      { category: "Fix", text: "Removed duplicate enable checkbox from Unfollow Tool when it is embedded inside the Human Session panel — the header checkbox is the one control." },
      { category: "Fix", text: "Follow Tool Start / Stop is now included in the Human Session Copy Settings dialog under Embedded Tool States." },
      { category: "Fix", text: "Per-hour and per-day action estimates on Follow, Unfollow, and Contact Users tools now reflect the Human Session delay timing when embedded, rather than each tool's own delay setting." },
    ],
  },
  {
    version: "1.0.731",
    date: "2 Jun 2026",
    items: [
      { category: "Fix", text: "Unfollow Tool now has its own enable/disable checkbox in the Human Session panel header, matching the Follow and Contact tools." },
      { category: "Fix", text: "Contact Tool now has a master enable/disable checkbox in the Human Session panel header." },
      { category: "Fix", text: "Contact New Followers, Auto Reply, and Contact Users settings panels now collapse fully when their individual checkbox is unchecked." },
      { category: "Fix", text: "Dashboard activity log now shows 'Executing' instead of the tool name for follow_tool_start events." },
    ],
  },
  {
    version: "1.0.730",
    date: "2 Jun 2026",
    items: [
      { category: "Fix",    text: "Human Session no longer loops immediately after completing — the Execute Every timer is now respected and the session waits the correct interval before running again." },
      { category: "Fix",    text: "Toggling the Human Session master switch OFF no longer disables the Follow Tool — the toggle now only controls the overall Human Session operation." },
      { category: "UI",     text: "Execute Every (min/max) inputs are now shown inline on the same row as the Human Session title and master toggle, freeing a card slot." },
      { category: "UI",     text: "Dashboard activity log now shows 'Follow Tool Starting' and 'Follow Tool Ended' for follow sessions, separate from the Human Session 'Started'/'Complete' events." },
      { category: "Fix",    text: "EQX export now includes the trust score badge — importing the file on another machine restores it automatically." },
      { category: "UI",     text: "API calls log export now has a dedicated 'API Call' column for endpoint names (sync, timeline, etc.) with 'Human Session Emulation' in the Operation Name column for all emulation calls." },
      { category: "UI",     text: "Test Timing button result now appears inline to the right of the button and shows a random sample time from the configured range each click." },
    ],
  },
  {
    version: "1.0.729",
    date: "2 Jun 2026",
    items: [
      { category: "Fix", text: "Verify button on the accounts list page now immediately shows 'Verifying' status — previously only the account detail page updated the badge instantly." },
      { category: "Fix", text: "Force Emulation calls no longer mark an account as Logged Out when a single endpoint fails — each of the 7 calls is now logged individually (OK or FAIL) and errors are contained per-endpoint." },
      { category: "Fix", text: "Removed the reels_media endpoint from Force Emulation — it requires reel IDs and always returned 'Invalid reel id list' on a bare call." },
      { category: "Fix", text: "FetchConfig (qe/sync) removed from the Verify login sequence — it consistently returned '400 Invalid experiment' and never provided value." },
      { category: "Fix", text: "Expired session errors from the mobile API are now correctly surfaced as Logged Out on the account rather than being silently swallowed." },
    ],
  },
  {
    version: "1.0.728",
    date: "2 Jun 2026",
    items: [
      { category: "Fix", text: "Turning the Human Session master toggle OFF no longer causes the Follow, Unfollow or Contact tools to fire as standalone runners — the master toggle is now the only switch that controls execution." },
      { category: "Fix", text: "Contact Tool settings inside the Human Session panel are now greyed out when the Contact Tool checkbox is off, matching the behaviour of Follow and Unfollow." },
    ],
  },
  {
    version: "1.0.727",
    date: "2 Jun 2026",
    items: [
      { category: "Fix",  text: "Clicking an account name in the Activity Log now opens the Human Session tab instead of the old standalone Follow tab." },
      { category: "Fix",  text: "Removed the standalone Follow, Unfollow and Contact tabs from the account detail page — all tool configuration now lives exclusively inside the Human Session tab." },
      { category: "Fix",  text: "Timeline likes can no longer fire when Like Min/Max are both 0 — the standalone like action now skips immediately instead of defaulting to 2–5 likes." },
      { category: "Fix",  text: "Force Emulation calls are now recorded in the API call log export so you can verify they fired." },
    ],
  },
  {
    version: "1.0.726",
    date: "2 Jun 2026",
    items: [
      { category: "Fix",  text: "Enabling the Human Session master toggle when a session was already running (e.g. startup countdown active) now forces it to run immediately instead of waiting out the original delay." },
      { category: "Fix",  text: "If the Human Session fires but the account has no Instagram session yet, it now logs a clear warning in the Activity panel — 'Run Verify Credentials to establish one' — instead of silently doing nothing." },
      { category: "Fix",  text: "Human Session now logs a visible warning when the account status is not valid (e.g. verifying, action_blocked) so you can see exactly why a session is being held." },
      { category: "New",  text: "Sub-tool settings inside the Human Session panel (Follow, Unfollow, Contact) are now greyed out when their checkbox is unchecked, making it clear which tools are active in the next session." },
    ],
  },
  {
    version: "1.0.725",
    date: "2 Jun 2026",
    items: [
      { category: "Fix",  text: "Follow Tool inside the Human Session panel no longer shows an 'Executing' timestamp — only the master Human Session toggle shows execution status." },
      { category: "Fix",  text: "Unfollow Tool inside the Human Session panel now shows the estimated users per hour and per day, the same as the Follow Tool." },
      { category: "Fix",  text: "Enabling the Human Session master toggle now correctly runs Force Emulation followed by the Follow, Unfollow, and Contact tools in execution-order sequence with skip-chance logic applied to each." },
    ],
  },
  {
    version: "1.0.724",
    date: "1 Jun 2026",
    items: [
      { category: "Fix",  text: "Enabling a sub-tool checkbox inside the Human Session panel (Follow, Unfollow, Contact) no longer launches it as a standalone independent runner. Sub-tools now only execute when the Human Session master toggle is active." },
      { category: "Fix",  text: "When the Human Session is active, any existing standalone Follow/Unfollow/Contact runners for that profile are automatically stopped to prevent duplicated actions." },
      { category: "New",  text: "The Contact tool's three sections (Contact New Followers, Auto Reply, Contact Users) are now displayed as a single scrollable page instead of separate tabs, consistent with all other tools." },
    ],
  },
  {
    version: "1.0.723",
    date: "1 Jun 2026",
    items: [
      { category: "New",  text: "Follow Tool inside the Human Session panel now has its own enable/disable checkbox, same as the Unfollow Tool — you can start or stop it independently without touching the master toggle." },
      { category: "Fix",  text: "DMs Sent toggle on the Statistics page is now linked to the Contact tool (which handles all outgoing DMs) instead of the legacy standalone DM tool." },
      { category: "Fix",  text: "Follow and Unfollow toggles on the Statistics page now correctly reflect the same enabled state as the checkboxes inside the Human Session tool." },
      { category: "New",  text: "Open EB column can now be shown or hidden from the Columns dialog on the Statistics page, just like any other column." },
    ],
  },
  {
    version: "1.0.722",
    date: "1 Jun 2026",
    items: [
      { category: "Fix",    text: "Force Emulation now sends POST requests to the endpoints that require it (timeline, QE sync, launcher sync, analytics) — previously they used GET and were silently rejected by Instagram." },
      { category: "Fix",    text: "Enabling the Human Session master toggle no longer forces the Unfollow and Contact tools on — each tool's own checkbox controls it independently." },
      { category: "Fix",    text: "Execution-status timestamps (Executing / Scheduled for…) are now hidden next to embedded tool checkboxes inside the Human Session panel, since timing is managed by the session itself." },
      { category: "New",    text: "Copy Settings on the Human Session panel now includes Execution Order and Skip Chance settings for the Follow, Unfollow and Contact embedded tools." },
      { category: "Fix",    text: "Clicking Target Sources in the Follow Tool no longer causes a visible UI stutter — the view transition is now deferred." },
    ],
  },
  {
    version: "1.0.721",
    date: "1 Jun 2026",
    items: [
      { category: "Fix",    text: "Force Emulation now reliably fires when enabled — the setting check was too strict and could silently skip the calls." },
      { category: "Change", text: "Follow Tool no longer shows the 'Wait Until Next Session' input fields — session timing is controlled by the Human Session delay settings." },
      { category: "Change", text: "Unfollow Tool enable/disable is now a checkbox instead of a toggle switch, consistent with the rest of the UI." },
      { category: "Change", text: "Contact New Followers, Auto Reply, and Contact Users Sending sub-panel enables are now checkboxes instead of toggle switches." },
      { category: "New",    text: "Copy Settings on the Human Session panel now includes Force Emulation settings, and individual Start/Stop states for Unfollow Tool, Contact New Followers, Auto Reply, and Contact Users Sending." },
    ],
  },
  {
    version: "1.0.720",
    date: "1 Jun 2026",
    items: [
      { category: "Change", text: "Follow Tool, Unfollow Tool, and Contact Tool no longer show their own enable/disable toggle inside the Human Session panel — the master toggle at the top controls all of them." },
      { category: "Fix", text: "Clicking Verify Account now runs the full login process silently in the background — no browser window opens on screen during verification." },
      { category: "Fix", text: "Login button detection during automated verify now tries multiple strategies (submit type, text match, form button) and polls up to 5 seconds for the button to become active before clicking." },
    ],
  },
  {
    version: "1.0.719",
    date: "1 Jun 2026",
    items: [
      { category: "New", text: "Force Emulation — a new section in Human Session settings that fires a sequence of Instagram app-open API calls at the start of every session, before any tools run." },
      { category: "New", text: "Force Emulation has an optional Randomise Order toggle that shuffles the API call sequence each session for more natural-looking behaviour." },
      { category: "Change", text: "Tool headers for Follow, Unfollow and Contact tools now show Execution Order and Skip Chance right-aligned on a two-row layout, matching the style of the other session controls." },
      { category: "Change", text: "Separator borders between embedded tools are now 10px (up from 5px) with extra row spacing above and below for clearer visual separation." },
      { category: "Change", text: "Tool titles (Follow Tool, Unfollow Tool, Contact Tool) are now bold and slightly larger." },
    ],
  },
  {
    version: "1.0.718",
    date: "1 Jun 2026",
    items: [
      { category: "New", text: "Follow Tool, Unfollow Tool, and Contact Tool (with all sub-tools) are now embedded directly inside the Human Session Emulation tab — configure everything from one place." },
      { category: "New", text: "Each embedded tool (Follow, Unfollow, Contact) has its own Execution Order and Skip Chance % controls for fine-grained scheduling within the session." },
      { category: "New", text: "The Human Session master toggle now controls all embedded tools in one shot — enabling or disabling the session also enables or disables Follow, Unfollow, and Contact simultaneously." },
      { category: "Change", text: "Follow Tool, Unfollow Tool, and Contact Tool tabs have been removed from the account tab bar — all tool settings are now in the Human Session Emulation tab." },
    ],
  },
  {
    version: "1.0.717",
    date: "1 Jun 2026",
    items: [
      { category: "Fix", text: "Clear Cookies now immediately navigates the open embedded browser to the Instagram login page and wipes the Electron session storage — you will no longer see a stale white screen after clearing." },
      { category: "Change", text: "Removed the Create a Cookie tab from Account Settings — cookie injection is still available within the Settings tab." },
      { category: "Debug", text: "Added comprehensive page-load diagnostics to the embedded browser: every navigation and load event is now logged with URL, body length, and session cookie presence, making blank-screen diagnosis much easier." },
      { category: "Debug", text: "Blank-screen recovery now covers all Instagram pages (not only accounts/login/#) — any page that finishes loading with an empty body will auto-recover to the feed or login." },
    ],
  },
  {
    version: "1.0.716",
    date: "1 Jun 2026",
    items: [
      { category: "Fix", text: "Account settings: API User Agent string is no longer shown twice — the picker is the only control and the full string is displayed below it as plain readable text." },
      { category: "Fix", text: "Account settings: Clear Cookies button is now always clickable — you no longer need a verified session to clear cookies." },
      { category: "Fix", text: "Embedded browser: added a second blank-screen recovery path covering full-page navigations to accounts/login/# with an empty body, closing the gap that caused persistent white screens after 2FA on newer builds." },
      { category: "New", text: "Accounts: new Reset Device IDs + Clear Cookies action wipes cookies and assigns fresh device fingerprints in one step." },
      { category: "Change", text: "Accounts actions popup is now 3 columns wide, fitting more actions without scrolling." },
    ],
  },
  {
    version: "1.0.715",
    date: "1 Jun 2026",
    items: [
      { category: "Fix", text: "Embedded browser: blank screen after 2FA is now auto-recovered — if the browser lands on the login hash route with no 2FA form visible, it navigates to the home feed after 3 seconds." },
      { category: "Fix", text: "Embedded browser: 2FA entry is protected — the recovery only fires when no 2FA input is on screen, so manual code entry is never interrupted." },
      { category: "Change", text: "Right-click View Page Source now opens the source directly in your text editor instead of showing a save-to-disk dialog." },
    ],
  },
  {
    version: "1.0.714",
    date: "1 Jun 2026",
    items: [
      { category: "Fix", text: "Embedded browser: scraping-warning blank screen now prevented at the source — fresh sessions have the cookie-consent token pre-seeded so Instagram skips the challenge entirely." },
      { category: "Fix", text: "Embedded browser: if the consent page does load, the app automatically clicks Allow All Cookies and continues, with no blank screen." },
      { category: "Fix", text: "Account settings: full API User Agent string is now shown in a readable field below the device picker so you can see the complete string without truncation." },
      { category: "New", text: "Embedded browser: right-click now shows View Page Source — saves the page HTML to a file and shows you the path, useful for diagnosing blank screens." },
      { category: "New", text: "Embedded browser: right-click now includes Open DevTools for live debugging of any page in the embedded browser." },
    ],
  },
  {
    version: "1.0.713",
    date: "1 Jun 2026",
    items: [
      { category: "Fix", text: "Embedded browser: white screen after entering a 2FA code is now auto-recovered — the app detects the Instagram scraping-warning redirect loop and navigates to the home feed automatically." },
      { category: "Fix", text: "Verify button: clicking Verify now opens the visible embedded browser and runs the full login flow there, so you can see it working in real time." },
      { category: "Fix", text: "Reset Device IDs: status is now correctly reset to Pending even when the account was in a Locked or other protected state." },
      { category: "Fix", text: "Account settings: removed the duplicate tiny API User Agent string shown below the device picker — the picker alone now represents the selected agent." },
      { category: "Change", text: "Embedded browser toolbar: removed the AI Image button and its panel." },
      { category: "Change", text: "Embedded browser toolbar: Leak Check button now uses the same plain style as all other toolbar buttons." },
      { category: "Change", text: "Embedded browser toolbar: the Reload button now shows a standard circular-arrows icon." },
    ],
  },
  {
    version: "1.0.712",
    date: "1 Jun 2026",
    items: [
      { category: "Improvement", text: "Proxy Manager: account names assigned to each proxy are now larger and easier to read." },
      { category: "Improvement", text: "Proxy Manager: the remove-account button is now a red bin icon shown beside the account name on hover, replacing the small X at the far right." },
      { category: "Fix", text: "Proxy Manager: the Accounts column now toggles between least-to-most and most-to-least — the previous unsorted third state has been removed." },
    ],
  },
  {
    version: "1.0.711",
    date: "1 Jun 2026",
    items: [
      { category: "Change", text: "Track API tool removed — the proxy/traffic interception feature has been removed from the sidebar and the app entirely." },
    ],
  },
  {
    version: "1.0.710",
    date: "1 Jun 2026",
    items: [
      { category: "Fix", text: "Track API: phone no longer loses internet connection when the proxy is active — root cause was forge's pure-JavaScript RSA key generation (1–3 seconds per domain cert) blocking the entire Node.js event loop, causing every queued iPhone connection to time out. Cert generation now uses Node.js's native OpenSSL implementation (~50ms) so the proxy stays responsive at all times." },
    ],
  },
  {
    version: "1.0.709",
    date: "1 Jun 2026",
    items: [
      { category: "Fix", text: "Track API: phone no longer loses internet connection — the MITM interceptor now only decrypts Instagram domains (i.instagram.com, instagram.com, graph.instagram.com). All other traffic (Facebook SDK, Apple, Google) is tunnelled transparently." },
      { category: "Fix", text: "Track API log no longer shows gibberish Facebook/Apple SDK calls — only actual Instagram API endpoints are decrypted and labelled. Non-Instagram traffic flows through without appearing in the log." },
      { category: "Fix", text: "Track API log now populates immediately when you open the page — existing entries are pushed as a snapshot the moment the WebSocket connects, no need to switch away and back." },
      { category: "UI", text: "Track API sidebar icon updated to a crosshair/target style that clearly communicates traffic tracking." },
      { category: "UI", text: "TrustScore icon picker: icons are now 50% larger (24px instead of 16px) making it much easier to see which icon you are selecting." },
    ],
  },
  {
    version: "1.0.943",
    date: "14 Jun 2026",
    items: [
      { category: "Fix", text: "Gemini AI now tries gemini-1.5-flash first, then gemini-1.5-flash-8b, then gemini-2.0-flash — each model has its own free-tier quota so if one is blocked another will work." },
    ],
  },
  {
    version: "1.0.942",
    date: "14 Jun 2026",
    items: [
      { category: "New", text: "Equinox Bot and Scan with AI now support Google Gemini — add your free Gemini API key in Settings → Security. Gemini is used automatically if set, with OpenAI as a fallback." },
      { category: "Fix", text: "Scan with AI no longer fails with a quota error for users who have a free or expired OpenAI account." },
    ],
  },
  {
    version: "1.0.708",
    date: "1 Jun 2026",
    items: [
      { category: "New", text: "Track API is now a full TLS MITM proxy — instead of just showing CONNECT tunnel hostnames, it decrypts HTTPS traffic and logs the actual Instagram API endpoints (e.g. Timeline Feed, Follow User, Like Post, Send DM)." },
      { category: "New", text: "Track API shows a plain-English label badge on every recognised Instagram API call — over 60 endpoint patterns mapped including feed, friendships, media, direct messages, stories, explore, and more." },
      { category: "New", text: "Track API generates a CA certificate on first start — download it, AirDrop to iPhone, install the profile, and trust it in Certificate Trust Settings to enable full HTTPS decryption." },
      { category: "Improvement", text: "Track API log now has a Hide Tunnels toggle (on by default) that removes raw CONNECT lines so only decoded API calls are visible. An Instagram calls counter shows how many IG endpoints were captured." },
    ],
  },
  {
    version: "1.0.707",
    date: "1 Jun 2026",
    items: [
      { category: "Fix", text: "Track API WiFi proxy: phone no longer loses internet when the proxy is configured — Windows Firewall step added to the setup guide with a one-click PowerShell command to allow the proxy port." },
      { category: "Improvement", text: "Track API now shows each PC network adapter by name alongside its IP, with a green WiFi badge on the most likely WiFi adapter — prevents accidentally picking a Hyper-V, VPN, or Docker virtual adapter IP." },
      { category: "Improvement", text: "Track API auto-selects the correct WiFi adapter IP on startup instead of defaulting to the first IP in the list." },
    ],
  },
  {
    version: "1.0.706",
    date: "1 Jun 2026",
    items: [
      { category: "Fix", text: "API Control throttle (min/max calls, min/max delay) now correctly applies to Follow, Like, and DM actions — they were bypassing the rate limit entirely when the account had a stored session cookie." },
      { category: "Fix", text: "Track API iPhone Setup Guide now includes 'Click Start Proxy' as step 1 — it was missing from the numbered steps, causing confusion about the correct order." },
      { category: "Fix", text: "Track API guide now explains that Instagram traffic shows as CONNECT (tunnel) entries in the log since Instagram uses HTTPS — no USB needed, WiFi only." },
    ],
  },
  {
    version: "1.0.705",
    date: "1 Jun 2026",
    items: [
      { category: "Change", text: "Track API is now iPhone-only — Android/ADB support removed. Connection panel shows a Same WiFi / SIM toggle with step-by-step iOS proxy setup instructions." },
      { category: "New", text: "Track API log now has a white background with black border and black text, making it easier to read captured traffic at a glance." },
      { category: "New", text: "Track API detects your PC's public IP automatically so you can route your iPhone's SIM (cellular) traffic through the proxy when on mobile data." },
    ],
  },
  {
    version: "1.0.704",
    date: "1 Jun 2026",
    items: [
      { category: "New", text: "Track API — new section in the sidebar. Start a local proxy, connect your Android phone via USB or WiFi, and see every HTTP request and HTTPS tunnel destination hit by Instagram in a live log viewer." },
      { category: "New", text: "ADB integration in Track API — click 'Set Proxy via ADB' to automatically configure the proxy on your connected phone without touching phone settings manually." },
      { category: "Fix", text: "Account user agents are now fully protected from accidental overwrite. Any form save or settings change that might have silently changed the UA string is now blocked — only Reset Device IDs can change the UA." },
      { category: "Change", text: "TrustScores moved from the sidebar into Settings → TrustScores tab. The sidebar slot has been replaced by the new Track API section." },
    ],
  },
  {
    version: "1.0.703",
    date: "1 Jun 2026",
    items: [
      { category: "Fix", text: "AI Image generator now retries up to 3 times if Pollinations.ai is busy, so a single rate-limit no longer blocks generation." },
      { category: "Fix", text: "Generated selfie now displays correctly in portrait — was previously squished into a square." },
      { category: "Fix", text: "Generate button now shows a live second counter (e.g. 'Generating… 12s') so you can see it's working." },
    ],
  },
  {
    version: "1.0.702",
    date: "1 Jun 2026",
    items: [
      { category: "Change", text: "AI Image generator is now completely free — switched to Pollinations.ai, no API key or account required. The OpenAI key field has been removed from Settings." },
    ],
  },
  {
    version: "1.0.701",
    date: "1 Jun 2026",
    items: [
      { category: "Fix", text: "AI Image generator switched to OpenAI's new gpt-image-1 model — the previous dall-e-3 model is no longer available on standard API keys." },
    ],
  },
  {
    version: "1.0.700",
    date: "1 Jun 2026",
    items: [
      { category: "Fix", text: "AI Image generation no longer fails with an 'Unknown parameter' error — updated to work with the latest OpenAI API format." },
    ],
  },
  {
    version: "1.0.699",
    date: "1 Jun 2026",
    items: [
      { category: "Change", text: "AI Image generator now uses OpenAI DALL-E 3 instead of Together AI — better quality selfies and no credits required beyond your own OpenAI key." },
      { category: "New", text: "Settings → Security: new Test button next to the OpenAI API key field — click it to verify your key is valid before trying to generate an image." },
    ],
  },
  {
    version: "1.0.698",
    date: "1 Jun 2026",
    items: [
      { category: "New", text: "OpenAI API key can now be entered directly in Settings → Security — no need to set a Windows environment variable." },
      { category: "Fix", text: "The AI Image button now shows a clear message directing you to Settings if no API key is configured, instead of a cryptic error." },
    ],
  },
  {
    version: "1.0.697",
    date: "1 Jun 2026",
    items: [
      { category: "New", text: "Added an AI Image button (✨ AI Image) to the native embedded browser toolbar — click it to generate a realistic AI selfie without leaving the browser window." },
      { category: "New", text: "The AI panel expands below the toolbar tab bar, showing a preview of the generated selfie along with its camera metadata (make, model, ISO)." },
      { category: "New", text: "Save button: download the generated AI selfie directly to your computer via a native save dialog." },
      { category: "New", text: "Upload to Instagram button: instantly delivers the AI selfie to the open Instagram file chooser (e.g. new post, story, profile picture) with one click." },
    ],
  },
  {
    version: "1.0.696",
    date: "1 Jun 2026",
    items: [
      { category: "Fix", text: "Fixed server crash on startup caused by the AI image generator trying to load the image processing library before it was available — the server now starts correctly even if the library is not yet ready." },
      { category: "Fix", text: "Bundled the image processing library (sharp) into the Windows installer so the AI selfie generator works out of the box without any extra installation steps." },
    ],
  },
  {
    version: "1.0.695",
    date: "1 Jun 2026",
    items: [
      { category: "Fix", text: "AI Image generator now produces different-sized photos every time — portrait, square, story format, and more — so each image has unique dimensions instead of always being the same square." },
      { category: "Fix", text: "AI Image EXIF data is now fully unique per image: different GPS location (randomised within a real city), unique image ID, random focal length variation, and unique body serial number." },
      { category: "UI",  text: "Human Session sub-action chance inputs are wider and labels (Notifs, Profile, Refresh, Settings) are fully visible — all four still fit on a single row." },
      { category: "Fix", text: "Error logs now include the exact message Instagram returned (e.g. 'Please wait a few minutes before trying again') alongside the error type, for all Follow, Unfollow, DM, Like, Stories, Reels, and Highlights errors." },
    ],
  },
  {
    version: "1.0.694",
    date: "1 Jun 2026",
    items: [
      { category: "Feature", text: "AI Image button added to the embedded browser toolbar — generates a realistic smartphone selfie using DALL-E 3, strips AI metadata, injects randomised camera EXIF (phone model, date, ISO). Requires an OpenAI API key in Settings → Security." },
      { category: "Feature", text: "Save and Upload buttons in the AI Image dialog — Save downloads the JPEG to your computer; Upload sends it directly to Instagram's active file chooser in the embedded browser." },
      { category: "UI", text: "Human Session sub-action run chances are now min–max ranges instead of a single fixed percentage — each session picks a random threshold within your range." },
      { category: "UI", text: "All four Human Session sub-actions (Notifications, Profile, Refresh, Settings) now display on a single compact row with their own min–max chance inputs." },
      { category: "UI", text: "Sidebar: Account Import icon is now a person with a + badge (no downward arrow). Ghost Browser moved above TrustScores. 'Bulk Import Accounts' renamed to 'Account Import'." },
    ],
  },
  {
    version: "1.0.693",
    date: "31 May 2026",
    items: [
      { category: "Fix", text: "API call throttle now correctly reads your Min/Max ms settings — calls are now properly spaced 25–60 seconds apart instead of firing instantly." },
      { category: "UI", text: "Account Settings tab labels and sidebar sub-tabs are now ALL CAPS." },
      { category: "UI", text: "Profile Sync controls (Auto Sync, interval, HikerAPI, Sync Now) now sit to the left of the Followers/Following/Posts stats in the Profile Sync card." },
      { category: "UI", text: "Group label and dropdown are now on the same row; group name text is bold." },
      { category: "UI", text: "Test Timing button added next to Max (ms) field — shows the expected per-call delay in seconds based on your current settings." },
      { category: "UI", text: "Equinox logo in the sidebar is 15% larger." },
    ],
  },
  {
    version: "1.0.691",
    date: "31 May 2026",
    items: [
      { category: "Fix", text: "Verify / API call timeout raised to 10 minutes — Instagram API calls are intentionally slow and must never be cut short." },
    ],
  },
  {
    version: "1.0.690",
    date: "31 May 2026",
    items: [
      { category: "UI", text: "Accounts page: the Import Profiles icon is now cyan so it's easier to spot in the Actions menu." },
      { category: "UI", text: "Accounts page: clicking the Sync column header now sorts by newest first; clicking again switches to oldest first. Same for the Last API Call column." },
      { category: "UI", text: "Equinox logo in the sidebar is now 15% larger." },
      { category: "Fix", text: "Login macro (Login button in the EB toolbar): after filling your username and password it now waits for the blue Login button to become active before clicking it, so the form actually submits instead of silently doing nothing." },
      { category: "Fix", text: "Verify no longer times out with a slow proxy — the internal timeout has been raised from 2 minutes to 4 minutes, giving the hidden browser enough time to load Instagram and complete the login even on a sluggish connection." },
    ],
  },
  {
    version: "1.0.689",
    date: "31 May 2026",
    items: [
      { category: "UI", text: "Follow Tool: all Inject Profile Browsing settings (%, feed posts, open post %, browse before follow) are now on a single row instead of stacked." },
      { category: "UI", text: "Copy Settings: the settings panel now shows separate 'Select All' and 'Select None' buttons that are always visible side by side." },
      { category: "UI", text: "Account profile tool tabs (Follow Tool, Unfollow, Human Session etc.) are now the same blue colour as the top navigation buttons." },
      { category: "Fix", text: "EB Browser window now opens fully maximised on Windows — the previous 25px gap at the top of the window is gone." },
      { category: "Fix", text: "Accounts that time out during verify are no longer incorrectly marked as 'locked' — they are reset to 'pending' so you can try again." },
      { category: "UI", text: "Proxy Manager: clicking 'Add Proxy' immediately adds an empty row to the list so you can fill in the details inline, instead of opening a popup form." },
    ],
  },
  {
    version: "1.0.688",
    date: "31 May 2026",
    items: [
      { category: "Fix", text: "Silent verify no longer hangs for 5 minutes — the proxy setup step now has a 10-second timeout so a stuck network service call fails fast instead of blocking the entire verify." },
      { category: "Fix", text: "Verify timeout on the API side reduced from 5 minutes to 2 minutes so a failed verify is reported quickly rather than leaving the account stuck in 'verifying' for 5 minutes." },
      { category: "Diagnostic", text: "Added step-by-step logging throughout the silent verify process (proxy setup, cookie load, hidden window creation, login) so future failures show exactly which step got stuck." },
    ],
  },
  {
    version: "1.0.687",
    date: "31 May 2026",
    items: [
      { category: "Fix", text: "Verify button now correctly submits the login form — the automated browser was filling in your credentials but the submit button stayed disabled because React hadn't finished updating; the app now waits up to 5 seconds for the button to become clickable before pressing it, then falls back to pressing Enter if needed." },
      { category: "Fix", text: "Cookie consent banner during silent verify now polls for up to 6 seconds after the page loads (previously only checked once at 1.5 s) so it's dismissed even when Instagram renders it late." },
      { category: "Fix", text: "Two-factor authentication detection during silent verify now recognises all input types Instagram uses for the TOTP code field, including the newer one-time-code and numeric input variants." },
    ],
  },
  {
    version: "1.0.686",
    date: "31 May 2026",
    items: [
      { category: "Fix", text: "Copy Settings: clicking a single account in the list now correctly toggles it — the drag-to-select feature introduced a double-toggle bug that caused every click to cancel itself out." },
      { category: "Fix", text: "Copy Settings: pressing ALL now selects only the accounts currently visible in the list (respecting any active search/status filter) — previously it added to any accounts that were already ticked from a prior session, which could silently copy settings to unintended accounts." },
      { category: "Fix", text: "Copy Settings: accounts with no group are now labelled 'Ungrouped' in the group quick-select dropdown, matching the name used everywhere else." },
      { category: "Improvement", text: "Accounts page group mode: ungrouped accounts now appear under a proper 'Ungrouped' section header (dimmed, collapsible) instead of floating below all groups with no label." },
    ],
  },
  {
    version: "1.0.685",
    date: "31 May 2026",
    items: [
      { category: "Fix", text: "Verify button no longer falsely marks valid accounts as 'Account Disabled' — the automated login was being flagged by Instagram's bot detection and misclassified; it now correctly shows as a security challenge (open the EB, log in manually, then click Verify)." },
      { category: "Improvement", text: "Silent verify (the hidden browser that runs when you click Verify) now sets full Client Hints headers matching the account's user agent, making the automated login less detectable by Instagram." },
      { category: "Improvement", text: "Cookie consent banner is now dismissed via CDP before credentials are filled in during silent verify, preventing the banner from blocking the submit button." },
      { category: "Improvement", text: "After the cookie banner is accepted in the interactive embedded browser, the app now automatically clicks the 'Log In' button on the Instagram splash page using a trusted CDP click." },
      { category: "Improvement", text: "Template accounts are now excluded from the proxy auto-link flow, so they never get a proxy accidentally assigned to them." },
    ],
  },
  {
    version: "1.0.684",
    date: "31 May 2026",
    items: [
      { category: "Improvement", text: "Bulk Import sidebar icon redesigned — now shows three account rows (avatar dot + name bar) with an arrow entering from the right, clearly communicating what the button does." },
      { category: "Improvement", text: "Header logo enlarged from 32px to 42px for better visibility." },
      { category: "Improvement", text: "TrustScore icon picker expanded from ~370 to over 600 icons across all categories — major additions include weather variants, health/body icons, new chart types, Scan icons, more monitor and server variants, bot icons, and new food items." },
      { category: "Fix", text: "Jarvee binary profile import now correctly reads passwords, proxy credentials, and all other fields — the file is now parsed server-side using the proper binary format decoder instead of the simplified browser parser that was missing data." },
    ],
  },
  {
    version: "1.0.683",
    date: "31 May 2026",
    items: [
      { category: "Improvement", text: "Dashboard and Bulk Import sidebar icons replaced with chunkier filled designs that match the rest of the nav icons." },
      { category: "Improvement", text: "Sidebar header simplified — back/forward buttons removed, logo centred at nav-icon size, Equinox wordmark placed neatly below it." },
      { category: "Improvement", text: "TrustScore icon picker Animals category expanded with Rabbit, Squirrel, Shrimp, Paw Print and Feather icons." },
    ],
  },
  {
    version: "1.0.682",
    date: "31 May 2026",
    items: [
      { category: "Improvement", text: "Device pool expanded from 86 to 118 unique devices — duplicate models removed, 6 new 1440p flagship profiles added (Galaxy S23 Ultra, S22 Ultra, S21 Ultra, Note 20 Ultra, OnePlus 12, Pixel 7 Pro), and 5 budget 720p devices added for a more realistic spread." },
      { category: "Improvement", text: "Seven new locales added to the device pool: Brazilian Portuguese, German, French, Mexican Spanish, Indonesian, Australian and Canadian English — reducing the US-only bias from 69% to 57%." },
      { category: "Improvement", text: "29 stale embedded Chrome versions (108–121, over two years out of date) updated to the 124–136 range — old Chrome versions on new Android phones are a strong bot signal." },
      { category: "Improvement", text: "Ghost Browser GPU fingerprint pool expanded from 8 to 20 GPU options covering Adreno 619–750, Mali-G52 through G920, and all three Tensor generations." },
    ],
  },
  {
    version: "1.0.681",
    date: "31 May 2026",
    items: [
      { category: "Improvement", text: "Account creation now uses a mobile-issued device ID (mid) from Instagram's own API instead of the web browser's mid — removing a key cross-context fingerprint mismatch that was flagging new accounts as bots." },
      { category: "Improvement", text: "The signup pre-login warmup now includes the is_main_native_login signal that real Android apps send on their first API call, making the device's cold-start sequence indistinguishable from a genuine phone." },
      { category: "Fix", text: "Trust score badge pills now hard-cut long labels (e.g. WARMUP) at the pill edge instead of showing trailing dots." },
    ],
  },
  {
    version: "1.0.680",
    date: "31 May 2026",
    items: [
      { category: "Fix", text: "Ghost Browser trending reel warmup now fetches content from real Instagram hashtags (#reels, #viral, #trending, #fyp) instead of scraping corporate accounts like NBA and CNN." },
      { category: "Fix", text: "Ghost Browser signup/login overlay dismiss now catches overlays that appear 3–8 seconds after page load using continuous polling, and navigates back if clicking the dismiss button accidentally redirects to a different page." },
      { category: "Fix", text: "Ghost Browser warmup no longer triggers an Instagram homepage redirect when hiding the signup overlay — the overlay is now hidden via CSS instead of clicking, avoiding any navigation." },
      { category: "Fix", text: "Ghost Browser fingerprint now correctly identifies as a mobile Android device — the platform and mobile Client Hints were previously reporting as Windows desktop, causing instant detection by Instagram." },
      { category: "Improvement", text: "Trust score badge pills are now a uniform fixed width across all accounts, so the Accounts and Dashboard columns stay aligned regardless of the badge label length." },
    ],
  },
  {
    version: "1.0.679",
    date: "31 May 2026",
    items: [
      { category: "Fix", text: "Copy Settings now reliably remembers your selected accounts and options between opens — the save-on-mount bug that was clearing your selection has been resolved." },
      { category: "Fix", text: "Human Session 'Randomise timing' now correctly staggers each account's first session start using the Copy Settings stagger offset, so accounts no longer all fire simultaneously." },
      { category: "Fix", text: "Account tool tabs (Account Settings, Follow Tool, Unfollow Tool etc.) now display in full foreground colour with a cyan underline on the active tab, matching the sidebar navigation style." },
      { category: "Fix", text: "Ghost browser signup page now always scrolls to the top on load — the page was previously opening mid-scroll." },
      { category: "Fix", text: "Pre-signup reel warmup flow no longer triggers the signup overlay dismissal — the dismiss logic is now suppressed during warmup to prevent Instagram from redirecting to the homepage." },
    ],
  },
  {
    version: "1.0.678",
    date: "31 May 2026",
    items: [
      { category: "Feature", text: "Copy Settings dialog now remembers your selected accounts and settings between opens — selections persist until you press NONE / Deselect All or restart the app." },
      { category: "Feature", text: "Copy Settings search now matches TrustScore badge names — type 'warmup', 'snail', 'monster' etc. to filter accounts by their badge." },
      { category: "Feature", text: "Copy Settings account list now supports click-and-drag to select multiple accounts at once, matching the behaviour on the main Accounts page." },
    ],
  },
  {
    version: "1.0.677",
    date: "31 May 2026",
    items: [
      { category: "Fix", text: "Ghost Browser warmup no longer redirects to the Instagram homepage — the warmup now watches reels passively without attempting to close the signup/login dialog (closing it was what triggered the redirect)." },
      { category: "UI", text: "TrustScores page title and subtitle are now left-aligned." },
      { category: "Fix", text: "TrustScore badge columns 2–5 now stay aligned even when the last row has fewer than 5 badges (items 16–19 no longer drift out of position)." },
    ],
  },
  {
    version: "1.0.676",
    date: "31 May 2026",
    items: [
      { category: "Fix", text: "Ghost Browser warmup no longer gets stuck in a redirect loop — when Instagram redirects away from a reel (either after popup dismiss or mid-watch), the browser moves straight to the next reel instead of trying to go back." },
    ],
  },
  {
    version: "1.0.675",
    date: "31 May 2026",
    items: [
      { category: "Fix", text: "Ghost Browser no longer keeps viewing the same reel — each warmup session now picks a different set of reels from a randomised pool of 14 popular accounts, with already-seen reels skipped for one hour." },
      { category: "Fix", text: "When Instagram redirects away from a reel during warmup, the browser immediately moves on to the next reel instead of wasting the remaining idle time on the homepage." },
      { category: "Fix", text: "All automatic popup dismissal now stops once warmup is complete — signup and verification dialogs are no longer auto-closed while you are filling in the form." },
      { category: "UI", text: "Fingerprint section is now always visible at the bottom of the Ghost Browser controls — no collapse toggle." },
      { category: "UI", text: "Pre-Signup Warm-up section now shows its current status directly below the title. Removed the separate Warm-up status card at the bottom." },
      { category: "Fix", text: "Follow tool now always re-scrapes when below session target — the re-scrape loop no longer requires a global setting to be enabled." },
      { category: "Fix", text: "Initial candidate pool for follow tool increased to at least 20 users so there are enough candidates to absorb skips without running dry." },
    ],
  },
  {
    version: "1.0.674",
    date: "30 May 2026",
    items: [
      { category: "Fix", text: "Ghost Browser no longer redirects to the homepage when the sign-up wall popup is dismissed — if a redirect happens the browser immediately returns to the reel." },
      { category: "Fix", text: "Reel watch time is now pure viewing — scrolling during the wait period has been removed so the reel plays uninterrupted for the configured number of seconds." },
      { category: "UI", text: "Statistics moved directly under Accounts in the left sidebar." },
      { category: "UI", text: "Accounts icon updated to a single filled person. Statistics icon updated to 3 ascending filled bars." },
    ],
  },
  {
    version: "1.0.673",
    date: "30 May 2026",
    items: [
      { category: "Fix", text: "Ghost Browser now opens directly on a trending reel — HikerAPI fetches a reel URL before the browser launches, so the login page and homepage are never shown." },
      { category: "Fix", text: "Sign-up wall popup ('Never miss a post' / 'See photos and videos') is now detected by its body text and dismissed even when the close button has no aria-label — works on all Instagram reel modal variants." },
    ],
  },
  {
    version: "1.0.672",
    date: "30 May 2026",
    items: [
      { category: "Fix", text: "Ghost Browser warm-up now works correctly in the Windows app — the Electron browser also fetches trending reels via HikerAPI first and lands directly on each reel, with no homepage visit, no profile browsing, and no post scrolling." },
      { category: "Fix", text: "The sign-up wall popup ('See photos, videos and more') is now auto-dismissed every 3 seconds during reel viewing in the Windows app." },
    ],
  },
  {
    version: "1.0.671",
    date: "30 May 2026",
    items: [
      { category: "Feature", text: "Ghost Browser warm-up now uses HikerAPI to fetch trending reels before the browser opens — the embedded browser lands directly on a real trending reel instead of the Instagram homepage." },
      { category: "Change", text: "Removed Visit Profiles and Click & View Posts settings from the Ghost Browser warm-up. View Trending Reels is now the only warm-up action." },
      { category: "Fix", text: "The 'See photos, videos and more' sign-up wall popup that appears on Instagram reels is now automatically dismissed within 1–10 seconds by clicking its X close button." },
    ],
  },
  {
    version: "1.0.670",
    date: "30 May 2026",
    items: [
      { category: "Fix", text: "Warm-up overlay prompts (the 'Sign up to see more' dialog) are now actually clicked closed — previously the button was found but the click was not registered because Instagram uses React events. The close button is now clicked via the same trusted CDP mechanism used for cookie banners, so it always dismisses." },
      { category: "Fix", text: "Reels warm-up no longer shows 'this link may be broken' — /reels/ and /reels/trending/ require login. The warm-up now browses the reels tab of public accounts (NatGeo, NASA, CNN etc.) which load correctly without an account." },
      { category: "Fix", text: "Profile visits no longer repeat the same profile repeatedly — profiles are now shuffled before the warm-up starts so every profile in the list gets visited in a random order." },
      { category: "Feature", text: "Visit Profiles warm-up now has a sub-setting: Posts per profile (count range) and Browse time per post (seconds range). For each profile visited, the warm-up clicks into individual posts, spends the configured time reading them, then returns to the profile page." },
    ],
  },
  {
    version: "1.0.669",
    date: "30 May 2026",
    items: [
      { category: "Fix", text: "Ghost Browser pre-signup warm-up now correctly runs all scroll, reel, and profile steps — two bugs were killing it early: the cookie label list was defined in a different part of the code and caused an invisible error that skipped straight to 'complete', and a failed navigation (ERR_ABORTED) was being treated as a success, leaving the page unloaded before scrolling began." },
      { category: "Fix", text: "Warm-up navigation is now robust against Chromium cancelling in-flight page loads — ERR_ABORTED is silently ignored and the warm-up keeps waiting for the page to fully load before scrolling or moving on." },
      { category: "Diagnostics", text: "Dense warm-up logging now appears in equinox-debug.log — every nav() start, settle, and ERR_ABORTED event is recorded so future issues can be diagnosed from the Windows log file." },
    ],
  },
  {
    version: "1.0.668",
    date: "30 May 2026",
    items: [
      { category: "Dashboard", text: "Activity log now shows an 'Equinox Started' entry every time the software starts or restarts — account is labelled 'Equinox' with a cyan Started badge and the exact date and time." },
      { category: "Fix", text: "Ghost Browser pre-signup warm-up now actually navigates and scrolls on Windows — a navigation race between the browser opening and warm-up starting caused all actions to run on a blank page; the warm-up now waits for the browser to finish its initial load before navigating." },
    ],
  },
  {
    version: "1.0.667",
    date: "30 May 2026",
    items: [
      { category: "Fix", text: "Ghost Browser page no longer shows a white screen when clicked — a hook ordering bug caused a crash before any UI could render." },
      { category: "UI", text: "Sidebar icons updated: TrustScores star, Ghost Browser ghost, Settings cog, and Proxy Manager shield are now solid filled with the brand cyan colour; ghost eyes, cog centre, and shield exclamation mark are white for contrast." },
    ],
  },
  {
    version: "1.0.666",
    date: "30 May 2026",
    items: [
      { category: "Fix", text: "Pre-Signup Warm-up progress now shows in real time on Windows — the Ghost Browser was running the warm-up in the background but the step messages were never reaching the screen because the browser runs as its own window." },
    ],
  },
  {
    version: "1.0.665",
    date: "30 May 2026",
    items: [
      { category: "Fix", text: "Ghost Browser: cookie consent banner is now accepted on every page load using the same click mechanism Puppeteer uses (CDP mouse dispatch) — the previous approach used a weaker click method that Instagram's React app sometimes ignored on Windows." },
      { category: "Fix", text: "Ghost Browser: cookie banner check now fires on every page navigation, not just once at window open — previously the check stopped after 60 seconds so banners on later pages were never dismissed." },
    ],
  },
  {
    version: "1.0.664",
    date: "30 May 2026",
    items: [
      { category: "Fix", text: "Ghost Browser: cookie consent banner is now correctly detected and accepted on Windows — Instagram's 'Allow all cookies' link is now found even when rendered as an anchor element rather than a button." },
      { category: "Fix", text: "Ghost Browser: Pre-Signup Warm-up now actually runs on Windows — the warm-up navigates the browser through the Instagram homepage, reels, posts, and profiles just like it does on web." },
      { category: "Fix", text: "Ghost Browser: warm-up progress messages (navigating homepage, watching reels, visiting profiles) now appear in real time on Windows." },
      { category: "Fix", text: "Pre-Signup Warm-up fields: count fields now accept 0–50 and idle time fields accept 0–3600 seconds — the previous floor of 1 second and ceiling of 10 items has been removed." },
    ],
  },
  {
    version: "1.0.663",
    date: "30 May 2026",
    items: [
      { category: "Improvement", text: "Ghost Browser: removed the redundant 'Run Warm-up' button — warm-up starts automatically when you click Start." },
      { category: "Improvement", text: "Ghost Browser: each warm-up activity (reels, posts, profiles) now has its own configurable viewing time in seconds so the session looks natural." },
      { category: "Improvement", text: "Ghost Browser: warm-up settings are remembered between sessions — no need to re-enter them every time." },
      { category: "Improvement", text: "Ghost Browser: the 'Never miss a post from Instagram' popup is now automatically dismissed on every page during warm-up." },
    ],
  },
  {
    version: "1.0.662",
    date: "30 May 2026",
    items: [
      { category: "Improvement", text: "Ghost Browser now auto-detects and accepts Instagram's cookie policy banner on every page — no more manual clicking required." },
      { category: "Improvement", text: "Warm-up starts automatically the moment you click Open Ghost Browser — no separate button click needed." },
      { category: "Improvement", text: "Warm-up now ends on the Reels feed instead of the homepage, so accounts don't all land on the same page after setup." },
    ],
  },
  {
    version: "1.0.661",
    date: "30 May 2026",
    items: [
      { category: "New", text: "Ghost Browser: Pre-Signup Warm-up settings panel — configure how many reels to view, posts to click into, and profiles to browse before the signup form is touched." },
      { category: "New", text: "Each warm-up count is randomised within the min–max range you set, so the session pattern is never identical between signups." },
      { category: "New", text: "Run Warm-up button drives the open Ghost Browser through Instagram content in real time; live step progress is shown in the panel as it runs." },
    ],
  },
  {
    version: "1.0.660",
    date: "30 May 2026",
    items: [
      { category: "New", text: "Ghost Browser signup now runs a 35-55 second warm-up session before touching the signup form — browses the Instagram homepage and public content (real reels via HikerAPI if configured, or popular public profiles as fallback) to build session history for the IP and device before signup begins." },
      { category: "Improvement", text: "Warm-up accepts the cookie banner and performs organic scrolling on each page visited, making the pre-signup browsing pattern indistinguishable from a real user." },
    ],
  },
  {
    version: "1.0.659",
    date: "30 May 2026",
    items: [
      { category: "Fix", text: "TrustScores page: icon picker now correctly displays all icons — switching from a direct stroke attribute to a CSS class colour fixes invisible icons in Electron's renderer." },
      { category: "Improvement", text: "TrustScores page: all badges and the page title are now centred instead of left-aligned." },
      { category: "Improvement", text: "Icon picker dialog is now 15% wider (852px) for more comfortable browsing." },
    ],
  },
  {
    version: "1.0.658",
    date: "30 May 2026",
    items: [
      { category: "Improvement", text: "Ghost Browser now fires realistic gyroscope and accelerometer sensor events continuously, matching what a real Android phone produces when sitting on a desk — eliminates a known bot-detection signal Instagram checks during signup." },
      { category: "Improvement", text: "Gyroscope and accelerometer permissions now correctly report as 'granted' inside the embedded browser, matching a real phone's permission state." },
    ],
  },
  {
    version: "1.0.657",
    date: "30 May 2026",
    items: [
      { category: "Fixed", text: "TrustScore icon picker: removed duplicate icons that were showing the same image under different names." },
      { category: "Improvement", text: "TrustScore icon picker: dialog is now 15% wider for easier browsing." },
      { category: "Improvement", text: "TrustScore badge editor: Pill Colour and Border Colour now have a 'None' button to set them to transparent." },
      { category: "Improvement", text: "TrustScore badges on the TrustScores page are now 25% larger — 5 badges fill each row more comfortably." },
      { category: "Improvement", text: "Accounts page: 'Add Profile' button renamed to 'Add Account' with no plus sign." },
      { category: "Improvement", text: "Add Account input is now cyan-styled, 3 digits wide, and capped at a maximum of 999." },
      { category: "Improvement", text: "Account Settings: Sync controls (Auto Sync, interval, HikerAPI, Sync Now) moved from the bottom to the top-right, beside the Group field." },
    ],
  },
  {
    version: "1.0.656",
    date: "30 May 2026",
    items: [
      { category: "Improvement", text: "Accounts page: removed sort direction arrows from all column headers — columns are still sortable by clicking, just cleaner." },
      { category: "Improvement", text: "Statistics page: removed sort direction arrows from column headers." },
      { category: "Improvement", text: "Copy Settings dialog: Status and TrustScore columns are now centred under their headers." },
      { category: "Fixed", text: "Icon picker: fixed missing icons caused by renamed lucide-react exports — all icons now display correctly." },
      { category: "Improvement", text: "Icon picker: categories moved to a left sidebar panel for easier browsing, dialog widened by 15%." },
      { category: "Improvement", text: "Accounts page: account names no longer forced to uppercase — they show exactly as entered." },
      { category: "Improvement", text: "Sidebar: TrustScores icon changed to a star, nav label text is always full contrast, Developing pill is no longer bold." },
    ],
  },
  {
    version: "1.0.655",
    date: "30 May 2026",
    items: [
      { category: "Feature", text: "TrustScores: subtitle updated to describe the section purpose clearly." },
      { category: "Feature", text: "TrustScore badges: each badge now has a pencil edit button — click it to customise pill colour, text colour, border colour, and icon." },
      { category: "Feature", text: "TrustScore icon picker: choose from 300+ icons organised into 14 categories (Speed, Rank, Animals, People, Tech, Security, Finance, Communication, Media, Sports, Symbols, World, Food, Design) with a live search bar." },
      { category: "Feature", text: "TrustScore badges now respect their individually saved colours everywhere they appear, including the score picker dropdown." },
      { category: "Fixed", text: "Accounts hitting consent_required during timeline activity now automatically accept Instagram's T&C via the mobile API and retry — no manual intervention needed." },
      { category: "Fixed", text: "Embedded browser now auto-dismisses Instagram TOS and age-verification popups every 10 seconds as a belt-and-suspenders fallback." },
    ],
  },
  {
    version: "1.0.654",
    date: "29 May 2026",
    items: [
      { category: "Fixed", text: "Unfollow Tool: list field can no longer be resized by dragging — it stays the fixed height." },
      { category: "Fixed", text: "Unfollow Tool: HikerAPI import now tries the v2 following endpoint first (which returns proper pagination cursors) before falling back to v1, allowing imports well beyond 25 users." },
    ],
  },
  {
    version: "1.0.653",
    date: "29 May 2026",
    items: [
      { category: "Feature", text: "TrustScores page: scores now show 5 per row with numbered positions." },
      { category: "Feature", text: "TrustScores: drag any score to reorder — sort order reflects everywhere accounts are sorted by trust score." },
      { category: "Feature", text: "TrustScores: click the red × on any score to delete it — confirms with a warning and stops all accounts assigned to that score." },
      { category: "Feature", text: "TrustScores: click the + button to add a custom trust score tier." },
    ],
  },
  {
    version: "1.0.652",
    date: "29 May 2026",
    items: [
      { category: "Feature", text: "Accounts: SYNC and LAST API CALL columns are now sortable — click the header to sort newest to oldest, click again for oldest to newest." },
      { category: "Improved", text: "TrustScore: Noob badge now shows a confused face icon, Warmup shows a stretching person, Class shows a diamond, Slug shows a custom slug with two eyes." },
    ],
  },
  {
    version: "1.0.651",
    date: "29 May 2026",
    items: [
      { category: "Fixed", text: "HikerAPI import now pages through results to collect up to 2000 followings instead of stopping at 200." },
      { category: "Improved", text: "Unfollow Tool: title, toggle, and next-execution time are now on a single row." },
      { category: "Improved", text: "Human Session Emulation: title, toggle, and next-execution time are now on a single row." },
      { category: "Improved", text: "Session Action Log and Follow Tool titles are now the same size as all other tool titles." },
    ],
  },
  {
    version: "1.0.650",
    date: "29 May 2026",
    items: [
      { category: "Improved", text: "Copy Settings opens with no accounts ticked by default — clean slate every time." },
      { category: "Improved", text: "TrustScore column in Copy Settings is now sortable by rank (NOOB first, GOD LEVEL last)." },
      { category: "Improved", text: "TrustScore column on the Accounts page is now sortable by rank." },
      { category: "Improved", text: "Account Name and Status column headers on the Accounts page are now all-caps for consistency." },
      { category: "Improved", text: "Navigation links (Accounts, Dash, Browser, Copy Settings) moved to the same row as the status pill and account name — no separate row above." },
    ],
  },
  {
    version: "1.0.649",
    date: "29 May 2026",
    items: [
      { category: "Improved", text: "Tool navigation (Follow, Unfollow, Contact, etc.) moved from the sidebar sub-buttons into a static horizontal tab bar directly below the account name — always visible regardless of which tool is active." },
      { category: "Improved", text: "Copy Settings now opens with all options de-selected by default — choose only what you want to copy." },
      { category: "Improved", text: "Copy Settings account list now has a dedicated TrustScore column, keeping the account name clean and the score easy to scan." },
      { category: "Fixed", text: "Account picker dropdown no longer shows a tick icon next to the currently selected account, removing the layout disruption." },
      { category: "Renamed", text: "'Human Session' is now called 'Human Session Emulation' throughout the app." },
    ],
  },
  {
    version: "1.0.648",
    date: "29 May 2026",
    items: [
      { category: "Fixed", text: "Account picker dropdown on Account Settings now only shows real accounts — TrustScore base profiles are excluded." },
      { category: "Fixed", text: "Copy Settings target list now also excludes TrustScore base profiles, showing only real accounts." },
      { category: "Improved", text: "Account picker dropdown and Copy Settings list now display each account's TrustScore badge next to the account name." },
      { category: "Fixed", text: "Human Sessions Copy Settings now includes the 'If 0 Posts → Follow Suggested' setting so it can be copied across accounts." },
    ],
  },
  {
    version: "1.0.647",
    date: "29 May 2026",
    items: [
      { category: "Fixed", text: "Account picker no longer shows internal Trust Score template profiles — only real accounts appear in the list." },
      { category: "Fixed", text: "Follow tool Inject Profile Browsing sub-settings (Feed Posts, Open Post%, Browse Before Follow) are now truly locked to one row and will not wrap." },
      { category: "Improved", text: "Trust Score icons updated: NOOB is now a sprout, SLUG a droplet, SLOTH a coffee cup, TORTOISE an anchor, REPTILE a scan, and MONSTER a ghost — all more recognisable at small sizes." },
    ],
  },
  {
    version: "1.0.646",
    date: "29 May 2026",
    items: [
      { category: "Improved", text: "Dashboard now loads only the most recent 2000 API log entries on startup — much faster on accounts with large log histories." },
      { category: "Improved", text: "Account picker dropdown now shows each account's Trust Score badge so you can identify accounts at a glance." },
      { category: "Improved", text: "Sidebar no longer shifts in width when profile sub-tabs appear — scrollbar is now hidden so the column stays exactly the same size." },
      { category: "Improved", text: "Follow tool Inject Profile Browsing settings (Feed Posts, Open Post%, Browse Before Follow + percentage) are now all on a single row." },
      { category: "Improved", text: "Follow tool Browse Before Follow now has its own X–Y percentage range input so you can control how often the profile browse happens before each follow." },
      { category: "Improved", text: "Follow tool Auto Follow/Unfollow section now shows Stop At and Start After side-by-side on one row, matching the unfollow tool layout." },
      { category: "New", text: "Human Sessions View Timeline Feed now has a 'If 0 Posts → Follow Suggested' option — when the timeline returns no posts, the bot follows X–Y users from the Suggested Users page to seed the feed." },
    ],
  },
  {
    version: "1.0.645",
    date: "29 May 2026",
    items: [
      { category: "New", text: "Follow tool now has an Inject Profile Browsing option — between follows it visits the target user's profile, scrolls their feed, and optionally opens posts, at a configurable X–Y% chance." },
      { category: "New", text: "Follow tool injection settings now include Feed Posts (min/max) and Open Post % to control how deeply the profile is browsed during each injection." },
      { category: "New", text: "New Browse Before Follow toggle on the Follow tool — when enabled, the target's profile is always browsed immediately before each follow action." },
      { category: "New", text: "All profile browsing API calls (visit profile, view feed, open post) are individually logged in the activity log." },
    ],
  },
  {
    version: "1.0.644",
    date: "29 May 2026",
    items: [
      { category: "Improvement", text: "Account names and status labels on the Accounts page are now displayed in uppercase." },
      { category: "New", text: "Statistics page groups now have a collapse/expand chevron button — click any group header to hide or show its accounts." },
      { category: "Fix", text: "Template profiles (used internally by TrustScores) no longer appear in the Statistics page or in the Copy Settings dialog." },
      { category: "Fix", text: "View Timeline actions — View Feed Post, Visit User Profile, and View User Feed — are now logged as API calls in the activity export." },
      { category: "Fix", text: "Removed the Clear Score option from the TrustScore dropdown — scores can only be changed, not cleared." },
    ],
  },
  {
    version: "1.0.643",
    date: "29 May 2026",
    items: [
      { category: "New", text: "Added Change Details to the Actions menu on the Accounts page — lets you update username, bio, and profile picture across multiple accounts using spintax for variation." },
      { category: "New", text: "Username and bio fields support spintax so each account can get a unique randomly-chosen value." },
      { category: "New", text: "Profile picture picker lets you select multiple images — one is randomly assigned to each account at run time." },
    ],
  },
  {
    version: "1.0.642",
    date: "29 May 2026",
    items: [
      { category: "Fix", text: "TrustScore dropdown now shows tier names and icons correctly — text was white on white background and invisible." },
      { category: "Fix", text: "TrustScore badge icons in the pill are now filled solid, matching the style on all other pages." },
      { category: "Improvement", text: "All automation tools now run strictly through the mobile API regardless of what the embedded browser is showing — cookie banners, ads, or other prompts in the EB no longer block tool execution." },
    ],
  },
  {
    version: "1.0.641",
    date: "29 May 2026",
    items: [
      { category: "Fix", text: "TrustScore pills no longer have a border — cleaner flat look across all pages." },
      { category: "Improvement", text: "TrustScore pill icons now use a solid white fill instead of outline-only." },
      { category: "Improvement", text: "TrustScores list is now displayed in two columns of 10 — all 19 tiers visible without scrolling." },
      { category: "Improvement", text: "TrustScore badges in the Accounts, Statistics, and Dashboard pages are now centre-aligned in their column." },
      { category: "Fix", text: "Fixed automatic follow↔unfollow switching — the opposite tool was being silently skipped when the engine's background reconciler interrupted the stagger delay. Now always enables the opposite tool regardless of timing." },
    ],
  },
  {
    version: "1.0.640",
    date: "29 May 2026",
    items: [
      { category: "Fix", text: "TrustScores and TrustScore detail pages now correctly show the full sidebar and navigation." },
      { category: "Improvement", text: "Sidebar status pill is now centred within the sidebar column." },
    ],
  },
  {
    version: "1.0.639",
    date: "29 May 2026",
    items: [
      { category: "New", text: "Added TrustScores section to the sidebar — click any of the 19 trust tiers to configure API limits and tool settings for that level." },
      { category: "New", text: "Each TrustScore tier now has its own settings page with API Limits & Control, Sync Options, Follow Tool, Unfollow Tool, Contact Tool, and Human Session tabs." },
      { category: "Improvement", text: "TrustScore pill colour changed to cyan with white text and icon across all 19 tiers." },
      { category: "Fix", text: "TrustScore dropdown now shows a solid white background instead of a transparent one." },
    ],
  },
  {
    version: "1.0.638",
    date: "29 May 2026",
    items: [
      { category: "Improvement", text: "TrustScore pill is now black with gold text and icon — applies to all trust levels." },
      { category: "Improvement", text: "Statistics moved directly under Accounts in the sidebar navigation." },
      { category: "Improvement", text: "Accounts page title changed from Account Name to Account Manager." },
      { category: "Improvement", text: "Human Session View Timeline — removed confusing percentage inputs for scrolling, replaced with Amount of Posts to Scroll count inputs. View Profile Feed row merged onto same line. All labels uppercased." },
      { category: "Fix", text: "Percentage input fields (%) no longer clip the value 100 — inputs widened to fit cleanly." },
    ],
  },
  {
    version: "1.0.637",
    date: "29 May 2026",
    items: [
      { category: "Fix", text: "TrustScore badge now shows empty by default instead of NOOB — only displays a level once you click and set one." },
      { category: "Fix", text: "TrustScore column now correctly appears on the Accounts page and Statistics page for users who had an older column layout saved." },
      { category: "Improvement", text: "TrustScore badge is now a compact pill matching the style of the Status badge — click to open a dropdown with a Clear option." },
      { category: "Improvement", text: "Sidebar 'Developing' label is now black instead of amber." },
      { category: "Improvement", text: "README & FAQ card in Settings no longer shows an arrow on the right." },
    ],
  },
  {
    version: "1.0.636",
    date: "29 May 2026",
    items: [
      { category: "New", text: "TrustScore badge added to Accounts page, Dashboard activity log, and Statistics page — click any badge to set or change the trust level for that account." },
      { category: "New", text: "TrustScore badge added inside each account's settings header, next to the account name picker navigation." },
      { category: "New", text: "Settings page now has five horizontal sub-category tabs (General, Scraping, Automation, Security, Data) so you can jump straight to what you need without scrolling the full list." },
      { category: "Improvement", text: "Activity Log and What's New tab icons are now solid filled cyan instead of outlines." },
      { category: "Improvement", text: "Sidebar status pill now shows 'Developing' label next to the amber dot." },
    ],
  },
  {
    version: "1.0.635",
    date: "29 May 2026",
    items: [
      { category: "Fix", text: "Audio fingerprint now applies seeded per-sample noise to every frequency bin — previously only 2 out of 1024 samples were modified, which was too small to produce unique fingerprint hashes across accounts." },
      { category: "Fix", text: "Status bar in the sidebar no longer shows the 'Amber' text label — only the coloured dot remains." },
      { category: "Fix", text: "Export Profiles and Export API Calls now open instantly in your default CSV editor instead of prompting you to save the file to disk first." },
      { category: "Fix", text: "Dashboard activity log now honours the Dashboard Log Limit setting — previously it was capped at 2,000 rows regardless of what you set." },
      { category: "Improvement", text: "Dashboard activity log and Session Log inside each profile now show 50 rows per page with previous/next page arrows — eliminates the lag caused by rendering thousands of DOM rows at once." },
      { category: "Improvement", text: "Settings: renamed 'API Log Limit' to 'Dashboard Log Limit' to better reflect what it controls." },
    ],
  },
  {
    version: "1.0.634",
    date: "28 May 2026",
    items: [
      { category: "Fix", text: "matchMedia pointer/hover queries now return mobile-correct values — Instagram's signup script checks these to detect touchscreens, and an Electron desktop window was returning desktop values that contradicted the mobile UA." },
      { category: "Fix", text: "visualViewport.width and outerWidth are now spoofed to match the mobile screen profile — previously they reported the real 1280px Electron window width." },
      { category: "Fix", text: "document.hasFocus() always returns true and document.visibilityState always returns 'visible' — background EB windows previously leaked false/hidden which Instagram treats as a bot signal during signup." },
      { category: "Fix", text: "window.ontouchstart is now defined (as null) to confirm touch support — its absence contradicted the maxTouchPoints=10 spoof." },
    ],
  },
  {
    version: "1.0.633",
    date: "28 May 2026",
    items: [
      { category: "Fix", text: "The embedded browser no longer physically resizes to mobile dimensions — it stays at its normal usable size. window.innerWidth and window.innerHeight are now spoofed at the JavaScript level to match the mobile screen profile, so the consistency check passes without squashing the window." },
    ],
  },
  {
    version: "1.0.632",
    date: "28 May 2026",
    items: [
      { category: "Fix", text: "window.innerWidth and window.innerHeight now return the same spoofed mobile dimensions as screen.width/screen.height — previously the EB's actual render width (1280px) was leaking through, which is physically impossible on a real phone and a clear bot-detection signal." },
    ],
  },
  {
    version: "1.0.631",
    date: "28 May 2026",
    items: [
      { category: "Fix", text: "Web Workers and OffscreenCanvas are now fingerprint-protected — any fingerprinting script running inside a Worker sees the same spoofed hardwareConcurrency, deviceMemory, platform, and WebGL GPU as the main page." },
      { category: "Fix", text: "screen.isExtended is now false — matches real mobile devices which never have an extended/multi-monitor setup." },
    ],
  },
  {
    version: "1.0.630",
    date: "28 May 2026",
    items: [
      { category: "Fix",     text: "Browser timezone now matches the proxy's exit country — Instagram no longer sees a mismatch between the IP location and the browser's reported timezone." },
      { category: "Fix",     text: "Browser viewport dimensions now match the spoofed mobile screen size — previously window.innerWidth could be detected as much larger than screen.width, a clear bot signal." },
      { category: "Fix",     text: "Canvas toBlob() is now noise-patched the same as toDataURL() — both canvas fingerprint extraction paths now return the same unique per-account hash." },
      { category: "Fix",     text: "Browser locale (date/number formatting via Intl APIs) now consistently reports en-US to match navigator.languages." },
      { category: "Fix",     text: "pdfViewerEnabled is now false — matches real Android Chrome behaviour." },
      { category: "Feature", text: "All browser clicks now follow a natural curved path with realistic speed and slight hand-tremor jitter instead of jumping instantly to the target coordinate." },
    ],
  },
  {
    version: "1.0.629",
    date: "28 May 2026",
    items: [
      { category: "Fix",     text: "Font fingerprint, speech synthesis voices, and audio hash are now unique per account — each account shows different detected fonts, different voice names, and a different audio hash in the Leak Check tool." },
      { category: "Fix",     text: "Account Settings device picker now shows the full API string (the technical identifier) as the selected value — brand and model only appear inside the dropdown when you open it to pick a new device." },
      { category: "Feature", text: "Ghost Browser now has a Fingerprint panel — click it to expand and see the unique WebGL GPU, canvas seed, audio noise, font seed, speech profile, and media device IDs assigned to the current session." },
      { category: "Feature", text: "Ghost Browser fingerprint regenerates automatically every time you press Nuke Environment, so each fresh session has completely different spoofed values." },
    ],
  },
  {
    version: "1.0.628",
    date: "28 May 2026",
    items: [
      { category: "Feature", text: "Each account now has a unique browser fingerprint stored permanently — WebGL GPU (vendor and renderer matched to the account device), canvas pixel noise, audio noise, and media device IDs are all unique per account and show different values in the Leak Check tool." },
      { category: "Feature", text: "Browser fingerprint is automatically generated the first time an account opens its embedded browser, and regenerated every time Reset Device IDs is pressed." },
      { category: "Feature", text: "Client Hints (navigator.userAgentData) now matches the account User Agent — brands, mobile flag, platform, model, and high-entropy values are all consistent with the assigned UA." },
    ],
  },
  {
    version: "1.0.627",
    date: "28 May 2026",
    items: [
      { category: "Feature", text: "New Browser Fingerprint Preview panel in Account Settings (under Embedded Browser Agent) — shows every value the Leak Tool measures: touch points, platform, color depth, orientation, battery charging/discharging time, network RTT, and all stealth protections (WebRTC, Canvas, Audio, webdriver). Values are computed from the account's UA so they match the Leak Tool exactly." },
    ],
  },
  {
    version: "1.0.626",
    date: "28 May 2026",
    items: [
      { category: "Fix", text: "Battery percentage, CPU cores, touch points, device memory, screen size, and connection speed in the Leak Tool now match exactly what Account Settings shows — the full hardware fingerprint script is now injected into the Embedded Browser on every navigation." },
      { category: "UI", text: "Sidebar icons increased by a further 10% (now 32px)." },
    ],
  },
  {
    version: "1.0.625",
    date: "28 May 2026",
    items: [
      { category: "Fix", text: "Ghost Browser Leak Test now correctly shows the User Agent Match panel — the live browser UA is passed directly since the Ghost has no saved account record." },
      { category: "UI", text: "Sidebar navigation buttons are 15% taller and icons are 20% larger." },
      { category: "UI", text: "Account sub-menu labels (Follow Tool, Unfollow Tool, etc.) now always fit on a single line." },
    ],
  },
  {
    version: "1.0.624",
    date: "28 May 2026",
    items: [
      { category: "Fix", text: "Fixed proxy not working in the Embedded Browser for HTTP proxies — Chromium rejects credentials embedded in the proxy URL (ERR_NO_SUPPORTED_PROXIES). Credentials are now supplied via the standard 407 auth challenge instead, which Chromium fully supports." },
    ],
  },
  {
    version: "1.0.623",
    date: "28 May 2026",
    items: [
      { category: "UI", text: "Sidebar navigation buttons are 15% taller." },
      { category: "Diagnostics", text: "Leak Test page now shows Proxy Type, Credentials status (set or not set), Electron's resolved routing path, and the raw proxy rules applied to the EB session — making it easy to confirm the proxy is actually being used." },
      { category: "Diagnostics", text: "When the Public IP test times out and a proxy is assigned, the page now clearly explains that the timeout means the proxy IS blocking direct traffic — and the real issue is the proxy server itself not forwarding the request (down, wrong credentials, or port blocked)." },
      { category: "Debug", text: "Electron now logs the full proxy configuration (type, host, port, has credentials, proxy rules) each time an Embedded Browser window is opened." },
    ],
  },
  {
    version: "1.0.622",
    date: "28 May 2026",
    items: [
      { category: "Fix", text: "Embedded Browser no longer opens blank after proxy fix — the proxy is now resolved entirely on the server using the same trusted path as the auto-login flow, eliminating a format mismatch that caused the window to load nothing." },
    ],
  },
  {
    version: "1.0.621",
    date: "28 May 2026",
    items: [
      { category: "Fix", text: "Proxy routing bug fixed — accounts with a proxy assigned via the Proxy Manager were getting no proxy applied to the Embedded Browser window, causing the home broadband IP to show instead of the proxy exit IP. The native EB window now correctly looks up and applies the Proxy Manager proxy for every account." },
      { category: "UI", text: "Sidebar is 15% narrower and nav buttons are 25% taller." },
      { category: "UI", text: "Navigation arrows (back/forward) moved below the logo, centered." },
      { category: "UI", text: "Dashboard icon updated to a gauge icon." },
      { category: "UI", text: "Account page top links now each show a matching icon (Dash, Browser, Account Settings)." },
    ],
  },
  {
    version: "1.0.620",
    date: "28 May 2026",
    items: [
      { category: "Fix", text: "Proxy IP Match test reverted to always show FAIL when exit IP differs from the assigned proxy — a residential-looking exit IP can still be the machine's real home broadband, so the test must always flag the mismatch and let the user decide." },
      { category: "UI", text: "Sidebar nav buttons are 25% taller for easier clicking." },
      { category: "UI", text: "Sidebar column is 15% narrower to give more room to the main content area." },
      { category: "UI", text: "Dashboard icon updated." },
      { category: "UI", text: "Proxy Manager label now shows full name instead of abbreviation." },
    ],
  },
  {
    version: "1.0.619",
    date: "28 May 2026",
    items: [
      { category: "Fix", text: "Proxy IP Match test — reverted: the residential-proxy auto-detection was incorrect and was masking real leaks. Removed." },
    ],
  },
  {
    version: "1.0.618",
    date: "28 May 2026",
    items: [
      { category: "Fix", text: "Reverted EB proxy from PAC script back to fixed_servers mode — the PAC script approach (introduced v1.0.607) was silently ignored by Electron 33/34, causing all EB traffic to go direct through the machine's real IP. The fixed_servers approach that worked in earlier versions is restored, with credentials now embedded directly in the proxy URL to avoid the 407 auth cycle entirely." },
    ],
  },
  {
    version: "1.0.617",
    date: "28 May 2026",
    items: [
      { category: "Fix", text: "IP Match leak test now shows FAIL (not WARN) when detected IP differs from proxy server IP, with a clear two-case explanation: real machine IP means the proxy is not routing at all; an unfamiliar residential IP is expected for residential proxies." },
      { category: "Fix", text: "EB proxy now re-applies on every page navigation (not just the first load) to defeat the persistent-session disk-load race where Chromium restores a stale proxy config from disk after the PAC script has been set." },
      { category: "Fix", text: "EB proxy re-open path now uses the same double-set + DNS flush treatment as fresh window creation, preventing a single-call race on re-show." },
    ],
  },
  {
    version: "1.0.616",
    date: "28 May 2026",
    items: [
      { category: "Fix", text: "Proxy IP Match explanation corrected — clarified that both static and rotating residential proxies will always show a different exit IP from the proxy host IP, because the host is the provider's entry-point server and the exit IP is the residential IP assigned to your account. This is expected behaviour, not a leak." },
    ],
  },
  {
    version: "1.0.615",
    date: "28 May 2026",
    items: [
      { category: "UI", text: "Sidebar nav buttons refined — now Jarvee-style with icon centred above short ALL-CAPS label, original header and back/forward arrows restored, original colour scheme kept, account sub-tabs restored as full text buttons. Proxy IP Match test changed from FAIL to WARN when exit IP differs from proxy host IP, with a clear explanation that rotating residential proxies always route through a different exit IP — not a leak." },
    ],
  },
  {
    version: "1.0.614",
    date: "28 May 2026",
    items: [
      { category: "UI", text: "Left sidebar redesigned to match Jarvee's square icon-button style — each nav item is now a compact square with a large centered icon and short ALL-CAPS label below, with an accent left-border on the active item. Profile sub-tabs shown as icon-only squares with hover tooltips when viewing an account. Sidebar is narrower (74px) giving more space to the main content area." },
    ],
  },
  {
    version: "1.0.613",
    date: "28 May 2026",
    items: [
      { category: "Fix", text: "DNS leak test fixed again — my-ip.io was returning the real machine IPv6 address because api.my-ip.io has a AAAA record and Chrome was opening it via a direct IPv6 socket that bypasses the HTTP proxy entirely (same failure mode as api64.ipify.org fixed in v1.0.611). Switched to api4.my-ip.io which is the IPv4-only subdomain — no AAAA record, all requests go through the proxy, and all three DNS sources now report the same proxy exit IP." },
    ],
  },
  {
    version: "1.0.612",
    date: "28 May 2026",
    items: [
      { category: "Docs", text: "Added chronological EB leak fix attempt log to developer docs — lists every approach tried (proxyRules→PAC, DoH removal, test tool fix), what the test showed before and after each, and a definitive 'do not re-attempt' list. Prevents future agent sessions from circling on theories that were already eliminated." },
    ],
  },
  {
    version: "1.0.611",
    date: "28 May 2026",
    items: [
      { category: "Fix", text: "DNS leak test fixed — the test was explicitly fetching api64.ipify.org (Cloudflare's dual-stack QUIC endpoint) which Chrome can open as a direct UDP/IPv6 connection that bypasses the HTTP proxy entirely. Switched to api.ipify.org (IPv4-only, no AAAA record, no QUIC) so all three DNS sources now route through the proxy, producing one consistent IP instead of two." },
      { category: "UI", text: "Sidebar nav buttons are now full-width edge-to-edge — removed the horizontal padding from the nav container so the active/hover background bar spans the entire sidebar width, matching Jarvee's style." },
      { category: "Fix", text: "Account list sort column and direction are now remembered across app restarts — switched from sessionStorage (cleared on close) to localStorage so your last sort choice persists." },
      { category: "Fix", text: "Accounts page now defaults to A–Z by account name on first load (no stored sort preference) instead of unsorted insertion order." },
    ],
  },
  {
    version: "1.0.610",
    date: "28 May 2026",
    items: [
      { category: "Fix", text: "CI build fixed — the Windows installer now builds cleanly again (removed the GitHub Releases publish step that required a secret token that wasn't configured)." },
    ],
  },
  {
    version: "1.0.609",
    date: "28 May 2026",
    items: [
      { category: "Fix", text: "DNS leak eliminated — DNS-over-HTTPS to Cloudflare was connecting directly via the real IP (not through the proxy), so Cloudflare's leak-test endpoint was seeing and reporting the real machine IP. DoH is now disabled; the PAC-script proxy handles DNS correctly by sending hostnames through CONNECT so the proxy does all DNS resolution." },
      { category: "Fix", text: "Proxy now re-applied at navigation start (before any page requests fire) as well as at page-load completion, and a 150 ms double-set on window open prevents the persistent session's disk-load from racing ahead and overwriting the proxy with a stale value." },
      { category: "Fix", text: "Verifying 3 or more accounts simultaneously no longer crashes the app — verify requests are now queued so only one silent-verify browser window exists at a time." },
      { category: "UI", text: "Sidebar navigation buttons are now explicitly square (no rounded corners) and the sidebar is 15% narrower for a more compact Jarvee-style layout." },
      { category: "UI", text: "System Status label updated from 'Developing' to 'in Development'." },
    ],
  },
  {
    version: "1.0.608",
    date: "28 May 2026",
    items: [
      { category: "Fix", text: "Embedded Browser proxy routing completely overhauled — switched from Chromium's fixed-server proxy rules (which silently fall back to a direct connection in Electron 33) to an inline PAC script that has no fallback path, so if the proxy is unreachable the request fails instead of leaking the real IP." },
      { category: "Fix", text: "IPv6 leak through proxy eliminated — the PAC script sends hostnames (not resolved IPs) to the proxy via CONNECT, so all DNS resolution happens on the proxy side and your machine's IPv6 address is never exposed." },
      { category: "Fix", text: "Belt-and-suspenders: proxy config is now re-applied after the first page load to handle a Chromium 130 edge case where persistent session disk-load can overwrite the proxy setting set at startup." },
      { category: "Fix", text: "Proxy authentication (407 challenge) now works correctly in multi-tab Embedded Browser sessions — each new tab window now has its own proxy credential handler." },
    ],
  },
  {
    version: "1.0.607",
    date: "28 May 2026",
    items: [
      { category: "Fix", text: "Proxy now correctly applies in the Embedded Browser for accounts whose proxy is set via the Proxy Manager — previously only inline proxy fields were used, so Proxy Manager-linked proxies were silently ignored and the real IP leaked." },
      { category: "Fix", text: "Ghost Browser now forwards the correct proxy type (HTTP vs SOCKS5) to the browser session so SOCKS5 proxies are no longer misidentified as HTTP, which caused silent connection failures." },
      { category: "Fix", text: "Leak test now correctly shows the assigned proxy in the Ghost Browser's Account Identity section instead of always showing 'No proxy assigned'." },
      { category: "Fix", text: "HTTP proxy rules now use explicit per-scheme format (http=... and https=...) so both HTTP and HTTPS traffic reliably route through the proxy in Chromium 130." },
      { category: "UI", text: "Main sidebar navigation buttons (Dashboard, Accounts, Ghost Browser, etc.) are now square — rounded corners removed as requested." },
    ],
  },
  {
    version: "1.0.606",
    date: "28 May 2026",
    items: [
      { category: "Fix", text: "Proxy now correctly routes all Embedded Browser traffic — switched from PAC script (which has a timing bug with persistent sessions in Electron 33 and silently falls back to direct) to mode:'fixed_servers' which Electron 33 applies synchronously and reliably." },
      { category: "Fix", text: "Proxy is now re-applied every time an account browser window is opened, not only when the proxy host changes — prevents stale sessions from bypassing the proxy after an app update or restart." },
      { category: "Fix", text: "DNS cache cleared on every browser window re-open to prevent stale entries from routing traffic around the proxy." },
    ],
  },
  {
    version: "1.0.605",
    date: "28 May 2026",
    items: [
      { category: "Fix", text: "Proxy now actually routes traffic in the Embedded Browser — the previous build used a deprecated Electron API (pacScript) that was silently ignored in Electron 33; switched to the correct pacURL + mode:'pac_script' form which Electron 33 honours." },
      { category: "Fix", text: "SOCKS5 proxy type is now correctly passed when opening an account's browser window — previously the proxy type was stripped, causing SOCKS5 accounts to be treated as HTTP proxies and fail." },
      { category: "Fix", text: "Ghost / signup browser window now also passes proxy type through correctly." },
    ],
  },
  {
    version: "1.0.604",
    date: "28 May 2026",
    items: [
      { category: "Fix", text: "All Embedded Browser windows now open maximised — re-opening an account browser that was previously un-maximised now correctly maximises it every time." },
      { category: "Fix", text: "Proxy IP and DNS leaks fixed: HTTP proxy sessions now use a PAC script instead of raw proxy rules, routing all traffic through the proxy server and eliminating the silent direct fallback that was exposing the real machine IP." },
      { category: "Fix", text: "IPv6 bypass leaks fully closed — Chrome now sends the hostname to the proxy via CONNECT so the proxy resolves DNS, meaning IPv6 connections to dual-stack sites never reach the machine directly." },
      { category: "Fix", text: "Happy Eyeballs V3 and IPv6 Reachability features disabled in Chrome to reduce IPv6 preference as an additional layer of protection." },
      { category: "Feature", text: "Export API Calls button restored to Accounts Actions menu — downloads a CSV of the full API call history, filtered to selected accounts if any are chosen." },
    ],
  },
  {
    version: "1.0.603",
    date: "27 May 2026",
    items: [
      { category: "Fix", text: "Fixed IPv6 / real-IP leak in Embedded Browser sessions: Chrome's QUIC (HTTP/3) protocol was opening direct UDP connections that bypass HTTP proxies — disabling QUIC forces all traffic through TCP where the proxy takes effect." },
      { category: "Fix", text: "Proxy bypass list is now set explicitly to loopback-only on every session, preventing Chromium's default bypass rules from accidentally letting non-loopback traffic skip the proxy." },
      { category: "Fix", text: "HTTP proxy rules changed to the all-schemes format so WebSocket and other connections are also routed through the proxy, not just HTTP and HTTPS." },
      { category: "Fix", text: "Fingerprint check: Public IP test now uses the IPv4-only endpoint so the proxy-IP match correctly reflects what the proxy serves, rather than a dual-stack endpoint that could use a different route." },
    ],
  },
  {
    version: "1.0.602",
    date: "27 May 2026",
    items: [
      { category: "Fix", text: "Proxy traffic no longer leaks the real IP — SOCKS5 proxies are now correctly recognised and connected using the SOCKS5 protocol instead of HTTP." },
      { category: "Fix", text: "WebRTC leak fully blocked — added a belt-and-suspenders fallback that overrides RTCPeerConnection at page load in case the earlier CDP injection missed it." },
    ],
  },
  {
    version: "1.0.601",
    date: "27 May 2026",
    items: [
      { category: "Fix", text: "Embedded Browser now opens correctly — the WebRTC protection setup no longer blocks the window from registering as open." },
      { category: "Security", text: "WebRTC TCP candidate blocking still active and applied before the first page script runs, without affecting the EB opening." },
    ],
  },
  {
    version: "1.0.600",
    date: "27 May 2026",
    items: [
      { category: "Security", text: "WebRTC TCP candidates (SPDY PUBLIC) are now blocked in the Embedded Browser — these bypassed the existing UDP policy and were exposing real IPv6 addresses." },
      { category: "Security", text: "WebRTC override is injected before any page script runs, so no website can gather real IP candidates of any kind (UDP or TCP) while the EB is open." },
      { category: "Security", text: "DNS queries now route through Cloudflare's encrypted DNS-over-HTTPS resolver instead of the ISP's plaintext DNS server, preventing DNS leak detection." },
      { category: "Security", text: "Same WebRTC and DNS protections applied to the hidden verify window, not just the visible EB." },
    ],
  },
  {
    version: "1.0.599",
    date: "27 May 2026",
    items: [
      { category: "Security", text: "WebRTC TCP candidates (SPDY PUBLIC) are now blocked in the Embedded Browser — these bypassed the existing UDP policy and were exposing real IPv6 addresses." },
      { category: "Security", text: "WebRTC override is injected before any page script runs, so no website can gather real IP candidates of any kind (UDP or TCP) while the EB is open." },
      { category: "Security", text: "DNS queries now route through Cloudflare's encrypted DNS-over-HTTPS resolver instead of the ISP's plaintext DNS server, preventing DNS leak detection." },
      { category: "Security", text: "Same WebRTC and DNS protections applied to the hidden verify window, not just the visible EB." },
    ],
  },
  {
    version: "1.0.598",
    date: "27 May 2026",
    items: [
      { category: "Security", text: "IPv6 completely disabled in Chrome's network stack — the machine's real IPv6 address can no longer leak through WebRTC, DNS, or any direct connection." },
      { category: "Security", text: "All traffic is now forced through IPv4, so every connection routes through the assigned proxy with no IPv6 bypass path possible." },
    ],
  },
  {
    version: "1.0.597",
    date: "27 May 2026",
    items: [
      { category: "Security", text: "WebRTC IP leak fixed in all Electron browser windows — no UDP candidates generated, proxy IP stays hidden from every website." },
      { category: "Security", text: "WebRTC protection covers the account EB, Ghost Browser, and silent-verify hidden window — all three now enforce the same policy." },
      { category: "Feature", text: "Leak Check page expanded from 9 tests to 20 — now includes DNS Leak, Proxy IP Match, User Agent Match, Font Fingerprint, Battery, Media Devices, Permissions, Speech Synthesis, Client Hints, and Timing Precision." },
      { category: "Feature", text: "Leak Check page now shows the account's assigned proxy, EB User Agent, and Mobile API User Agent at the top so you can confirm the correct identity is active." },
      { category: "Feature", text: "IP info card now shows ISP/ASN, datacenter flag, IPv4/IPv6 version, and compares the detected IP against the assigned proxy." },
      { category: "Feature", text: "Timezone card now compares the browser timezone against the proxy's geographic timezone and warns if they differ." },
    ],
  },
  {
    version: "1.0.591",
    date: "27 May 2026",
    items: [
      { category: "Fix", text: "EB content no longer hidden behind the toolbar — all Instagram content and the leak test page now start correctly below the 92px native toolbar." },
      { category: "Improvement", text: "Leak Check page switched to a white background with dark text for better readability in the EB." },
      { category: "Fix", text: "Leak Check IP test now times out cleanly after 8 seconds instead of hanging if the proxy blocks the lookup." },
      { category: "Fix", text: "System Status label in the sidebar changed from 'Dev' to 'Developing'." },
    ],
  },
  {
    version: "1.0.590",
    date: "27 May 2026",
    items: [
      { category: "Feature", text: "Added Leak Check button to the Windows Electron EB toolbar — green, runs the full in-app IP/WebRTC/WebDriver leak test." },
      { category: "Fix", text: "Leak Check button in the web EB panel changed from yellow to green and renamed from 'Leaks' to 'Leak Check'." },
    ],
  },
  {
    version: "1.0.589",
    date: "27 May 2026",
    items: [
      { category: "Improvement", text: "Full codebase sync — all source files verified and pushed to ensure the Windows installer includes every feature." },
    ],
  },
  {
    version: "1.0.588",
    date: "27 May 2026",
    items: [
      { category: "Fix", text: "GitHub Actions build workflow now correctly publishes releases so the auto-updater can find new versions." },
      { category: "Improvement", text: "Windows installer build now uses the locally installed electron-builder for reliability and caches Electron dependencies between runs." },
    ],
  },
  {
    version: "1.0.587",
    date: "27 May 2026",
    items: [
      { category: "Feature", text: "New Leaks button in every embedded browser toolbar — click it to run a full in-app environment test that checks your proxy IP, WebRTC leaks, bot detection signals, canvas and audio fingerprints, timezone, WebGL GPU info, and screen hardware, all in one clean page." },
    ],
  },
  {
    version: "1.0.596",
    date: "27 May 2026",
    items: [
      { category: "Fix", text: "Import Jarvee Binary: fixed the password field returning the same value for every account — a Jarvee settings label (short phrase with spaces) was passing the password filter; passwords never contain spaces so the filter now rejects any string with a space." },
    ],
  },
  {
    version: "1.0.595",
    date: "27 May 2026",
    items: [
      { category: "Fix", text: "Leak test: all 9 checks now fully run and display results — the script had remaining TypeScript syntax (type casts and non-null operators) that prevented the browser from executing any code at all." },
    ],
  },
  {
    version: "1.0.594",
    date: "27 May 2026",
    items: [
      { category: "Fix", text: "Import Jarvee Binary: password field now correctly imports the Instagram account password — it was pulling a status message instead of the actual password." },
    ],
  },
  {
    version: "1.0.593",
    date: "27 May 2026",
    items: [
      { category: "Fix", text: "Build pipeline: reverted installer publish mode to avoid a 401 error caused by a missing GitHub token secret — the installer is still available from the Actions tab as normal." },
    ],
  },
  {
    version: "1.0.592",
    date: "27 May 2026",
    items: [
      { category: "Fix", text: "Leak test: all checks now run and return results correctly — they were silently broken and every field was stuck spinning." },
      { category: "Feature", text: "Leak test title now shows the account's Instagram username (e.g. @myaccount LEAK TEST) instead of the generic Equinox heading." },
      { category: "Fix", text: "Ghost Browser leak check receives the same username-in-title fix." },
      { category: "Feature", text: "System tray icon tooltip now shows the app version alongside the name (e.g. Equinox v1.0.592)." },
      { category: "Fix", text: "Column arrangements on all pages — Accounts, Dashboard, Proxies, Stats, Bulk Import — are now fully remembered across app restarts and software updates." },
    ],
  },
  {
    version: "1.0.586",
    date: "27 May 2026",
    items: [
      { category: "Fix", text: "Follow tool: inject Search by Username no longer fires when the toggle is disabled — it was always running before the first follow regardless of the setting." },
      { category: "Fix", text: "Follow tool: inject Search by Username and inject Get Suggested Users now correctly fire based on percentage of users, not every run — when disabled, neither call is made at all." },
      { category: "Improvement", text: "Copy Settings dialog: removed the All Statuses filter dropdown to simplify the interface." },
      { category: "Improvement", text: "Copy Settings dialog: Select Group dropdown is now half width and placeholder text updated to Select Group." },
      { category: "Improvement", text: "Copy Settings dialog: search field placeholder changed to Search." },
      { category: "Feature", text: "Proxy manager: each proxy now has a Type column — select HTTP or SOCKS5 per proxy so the embedded browser routes traffic through the correct protocol and never falls back to a direct connection." },
    ],
  },
  {
    version: "1.0.583",
    date: "27 May 2026",
    items: [
      { category: "Fix", text: "Ghost Browser signup: added missing Accept-Language and sec-ch-ua Client Hint headers — headless Chrome was sending none by default, which Instagram's server flagged as a bot and rejected the email code even when it was correct." },
      { category: "Fix", text: "Ghost Browser signup: canvas state is now fully restored after injecting the per-session fingerprint pixel — previously fillStyle was left changed, which could corrupt text rendering in the signup form." },
      { category: "Fix", text: "Ghost Browser: audio fingerprint wrapper now falls back gracefully if the gain node cannot be inserted, preventing any risk of Instagram's JS receiving an unexpected error." },
      { category: "Fix", text: "Import Jarvee Binary: account email field no longer imports a contact's email — search is now limited to the SMTP section only, before the proxy host, so contact messaging emails are excluded." },
      { category: "Fix", text: "Import Jarvee Binary: password backward search window expanded from 20 to 40 records, catching more Jarvee versions that serialize the password earlier in the file." },
    ],
  },
  {
    version: "1.0.581",
    date: "27 May 2026",
    items: [
      { category: "Fix", text: "Last API Call column now shows immediately for all users — fixed a localStorage version conflict that was hiding the column even after it was enabled by default." },
      { category: "Fix", text: "Create Ghost: the automated form browser now uses an Android Chrome mobile identity by default (UA, touch viewport, screen size) so the browser-originated cookies match what the mobile verification step expects." },
      { category: "Fix", text: "Create Ghost: the automated browser now sends Accept-Language and sec-ch-ua Client Hints headers on all Instagram requests — headless Chrome was previously sending no locale header at all, a clear bot signal." },
      { category: "Fix", text: "Create Ghost: the automated browser now scrolls the Instagram homepage briefly before navigating to the signup form, adding organic dwell time that bots skip entirely." },
    ],
  },
  {
    version: "1.0.580",
    date: "27 May 2026",
    items: [
      { category: "Feature", text: "Accounts page: groups now have an icon/favicon slot between the group name and account count — click the small dashed box to browse your files and assign any image. Click again to replace it." },
      { category: "Improvement", text: "Last API Call column is now visible by default on the Accounts page. Shows how long ago each account last made a valid API call (excludes HikerAPI and error calls)." },
      { category: "Fix", text: "Fixed a crash on the Accounts page that triggered a 500 error every 30 seconds due to an undefined database reference in the Last API Call lookup." },
      { category: "Fix", text: "Ghost Browser: confirmation code entry now fires React-compatible input events so Instagram's controlled OTP fields always register the typed value correctly." },
    ],
  },
  {
    version: "1.0.579",
    date: "27 May 2026",
    items: [
      { category: "Feature", text: "Accounts page: new 'Last API Call' column showing how long ago each account last made a successful API call (hidden by default — toggle it on in Manage Columns). Excludes HikerAPI calls and any failed/error calls." },
    ],
  },
  {
    version: "1.0.585",
    date: "27 May 2026",
    items: [
      { category: "Fix", text: "Ghost Browser now always opens with a fully fresh session — closing and reopening it now properly destroys the old window so the selected proxy is applied correctly every time." },
      { category: "Fix", text: "Account embedded browsers now correctly route all traffic through the assigned proxy — a missing event.preventDefault() call was causing Electron to silently fall back to the home IP on every proxy authentication challenge." },
      { category: "Fix", text: "Proxy credentials are now read live from the account settings when the browser asks to authenticate — previously stale credentials from when the window was first opened were used even after the proxy was changed." },
      { category: "Fix", text: "New tabs opened inside an account embedded browser now use the account's proxy session — they were previously opening on a separate unproxied session." },
    ],
  },
  {
    version: "1.0.582",
    date: "27 May 2026",
    items: [
      { category: "Fix", text: "Binary file import now correctly extracts passwords — the parser now searches both before and after the username anchor and accepts a wider range of password formats." },
      { category: "Fix", text: "Binary file import now correctly reads account labels in the Jarvee format (e.g. 'AlterEgo_Fitness_SWQ | MODERATE') — the pipe-and-status pattern is now detected first." },
      { category: "Fix", text: "Binary file import now extracts email addresses that are stored near the POP/IMAP server settings section of the file." },
      { category: "Improvement", text: "Actions menu reordered — Import EQX and Export EQX now sit directly below Import/Export Profiles, followed by Import Binary File, then the EB buttons below the separator." },
      { category: "Fix", text: "Verify Accounts in the Actions menu no longer selects and verifies all accounts by default — it is now disabled until you select the accounts you want to verify." },
      { category: "Improvement", text: "Ghost Browser now injects a per-session fingerprint salt on every launch — canvas, audio, timing, and plugin signals all differ across account creation sessions even when using the same device identity." },
      { category: "Fix", text: "Fixed a crash in the automation engine where vtfResult was referenced before it was declared." },
      { category: "Improvement", text: "Sidebar and page headings renamed: 'Create a Ghost' is now 'Ghost Browser', and the Accounts column header is now 'Account Name'." },
    ],
  },
  {
    version: "1.0.578",
    date: "27 May 2026",
    items: [
      { category: "Improvement", text: "Nuke Environment now shows a proper nuclear trefoil icon instead of a bomb." },
      { category: "Improvement", text: "Spintax preview removed from under the Username Spin field — less clutter." },
      { category: "Improvement", text: "Controls panel spacing tightened — everything sits closer together above the action buttons." },
      { category: "Feature", text: "Paste buttons now inject text directly into the active field in the ghost browser. A separate Copy button copies to clipboard." },
      { category: "Fix", text: "Ghost browser was launching with a desktop viewport (1280×760) even when using a mobile user agent — fixed to use the correct mobile screen dimensions and touch settings." },
      { category: "Fix", text: "Ghost browser was missing the full JS-layer stealth scripts (WebGL, canvas noise, WebRTC lockdown, battery API, screen spoofing). These are now applied before the first page load." },
    ],
  },
  {
    version: "1.0.577",
    date: "27 May 2026",
    items: [
      { category: "Improvement", text: "Create a Ghost page cleaned up — email tip removed, proxy no longer duplicates the IP string below the dropdown, and the 'Selected' device box has been removed." },
      { category: "Improvement", text: "Device Identity now sits directly under the Proxy section with the action buttons immediately below it for a tighter layout." },
      { category: "Feature", text: "Anti-Detect panel moved to the very bottom of the controls column with all items centred." },
      { category: "Feature", text: "'Start from Fresh' renamed to 'Nuke Environment' with a bomb icon to better reflect what it does." },
      { category: "Feature", text: "Username Spin field added under Nuke Environment — supports Jarvee-style multilayered spintax to generate a username, with a one-click copy button." },
      { category: "Feature", text: "Password field added with an auto-generated strong password on load, a Regenerate button, and a one-click copy button." },
    ],
  },
  {
    version: "1.0.576",
    date: "26 May 2026",
    items: [
      { category: "Fix", text: "Cookie dismiss diagnostic logs now actually appear in the log file. The embedded browser runs in a separate process whose output was never captured — diagnostics are now relayed through the server so every CookieTick line shows up where you can see it." },
    ],
  },
  {
    version: "1.0.575",
    date: "26 May 2026",
    items: [
      { category: "Fix", text: "Cookie dismiss timer now logs every detection attempt for the first 20 seconds — including the page URL and whether the button was found or not. This makes it possible to diagnose exactly what's happening on each open." },
      { category: "Fix", text: "Auto-fill login sequence was still using the old broken cookie dismiss code. It now uses the same two-step approach as the main timer: detect-only JS returns coordinates, then the main process fires a trusted OS click, then the login form is filled." },
    ],
  },
  {
    version: "1.0.574",
    date: "26 May 2026",
    items: [
      { category: "Fix", text: "Cookie banner auto-dismiss now correctly registers the click. Instagram's app ignores programmatic JavaScript clicks (they are 'untrusted') — the dismiss now uses OS-level input events from the main process, which Instagram treats as real user input." },
      { category: "Fix", text: "Cookie dismiss now clicks at most 5 times, with a 4-second gap between each attempt. This prevents any possibility of spam-clicking while still handling cases where the first click is missed." },
      { category: "Improvement", text: "Cookie dismiss progress is now logged: each attempt shows the button label and screen coordinates so you can verify it is finding the right button." },
    ],
  },
  {
    version: "1.0.573",
    date: "26 May 2026",
    items: [
      { category: "Fix", text: "Embedded browser clicks are responsive again. The cookie auto-dismiss was injecting fake OS-level mouse events every 800ms, competing with your real clicks and making the EB feel frozen. These injected events have been removed — the dismiss now uses JavaScript only." },
      { category: "Fix", text: "Cookie banner no longer spam-clicks the wrong buttons. The previous fix matched any button containing the word 'cookie', which also matched category toggles like 'Functional cookies' on Instagram's preference page. The selector now uses an exact whitelist of accept-all phrases only." },
    ],
  },
  {
    version: "1.0.572",
    date: "26 May 2026",
    items: [
      { category: "Fix", text: "Cookie policy banner no longer gets stuck on new logins. The auto-dismiss now keeps retrying until the banner is actually gone from the page — previously it gave up after a single click attempt even if React silently dropped the event." },
      { category: "Fix", text: "Cookie banner detection now also matches 'Allow all' and 'Accept all' buttons — catches Instagram's latest banner variants." },
    ],
  },
  {
    version: "1.0.571",
    date: "26 May 2026",
    items: [
      { category: "Fix", text: "Cookie banner auto-dismiss now uses a smarter detection rule: any button whose text includes the word 'cookie' (in any language variant) is matched, instead of a fixed list of exact phrases. This catches Instagram's current and future button wording without risking clicks on Save Login or 2FA dialogs." },
    ],
  },
  {
    version: "1.0.570",
    date: "26 May 2026",
    items: [
      { category: "Fix", text: "Ghost browser clicks now use the same enhanced shadow DOM + pointer event chain as regular account browsers — cookie banners and React-driven overlays respond correctly during account creation." },
      { category: "Improvement", text: "View Timeline Feed cascade options are now flat and left-aligned instead of nested, making the settings easier to read and configure." },
      { category: "Improvement", text: "System Status in the sidebar now shows on a single line." },
      { category: "Info", text: "Create a Ghost now shows an Email Code Tip explaining that Instagram codes expire in ~60 seconds — have your email open before submitting so the code is still valid when you paste it." },
    ],
  },
  {
    version: "1.0.569",
    date: "26 May 2026",
    items: [
      { category: "Fix", text: "Cookie banner auto-dismiss no longer fires hundreds of clicks — the over-broad 'last button in any dialog' selector was matching Instagram's Save Login and 2FA dialogs, causing an infinite click loop. Now uses exact text matching only and clears itself immediately on the first successful dismiss." },
    ],
  },
  {
    version: "1.0.568",
    date: "26 May 2026",
    items: [
      { category: "Fix", text: "Ghost Browser (Create-a-Ghost) now uses a completely fresh in-memory browser session every time it opens — no cookies, IndexedDB, cache, or any other state can carry over from a previous session, eliminating the device leak that linked new accounts to each other." },
      { category: "Fix", text: "Cookie banner: added IndexedDB and File System to the storage clear list on every session wipe — Instagram stores its device token (mid) in IndexedDB as a backup and was silently restoring it after cookie clears." },
    ],
  },
  {
    version: "1.0.567",
    date: "26 May 2026",
    items: [
      { category: "Feature", text: "Human Sessions — View Timeline Feed now has a cascading browsing chain: set a % to open posts from the feed, then a % to visit that post's author profile, then a % to scroll their profile feed (with post count), then a count and % to open individual posts from that profile." },
    ],
  },
  {
    version: "1.0.566",
    date: "26 May 2026",
    items: [
      { category: "Fix", text: "Ghost Browser now opens as a proper detached native window (same as account EBs) instead of an embedded screencast panel." },
      { category: "Fix", text: "Cookie consent dialog on newly opened EBs is now auto-dismissed reliably regardless of how many browser windows are open simultaneously." },
    ],
  },
  {
    version: "1.0.564",
    date: "26 May 2026",
    items: [
      { category: "Update", text: "Replaced the Create an Account tab with Create a Ghost — a clean, isolated browser environment with proxy selection, device identity picker, open browser button, and full session reset." },
    ],
  },
  {
    version: "1.0.563",
    date: "26 May 2026",
    items: [
      { category: "Fix", text: "CI now builds the Windows installer without requiring GitHub Releases access — the installer is saved directly as a downloadable Actions artifact regardless of token configuration." },
    ],
  },
  {
    version: "1.0.562",
    date: "26 May 2026",
    items: [
      { category: "Fix", text: "Windows installer CI build fixed — build outputs are now transferred between jobs using a tar archive, guaranteeing the compiled server and frontend land in exactly the right place for packaging." },
    ],
  },
  {
    version: "1.0.561",
    date: "26 May 2026",
    items: [
      { category: "Fix", text: "GitHub Actions build workflow now correctly passes the compiled server and frontend to the Windows packaging step — the Windows installer will build successfully again." },
    ],
  },
  {
    version: "1.0.560",
    date: "26 May 2026",
    items: [
      { category: "UI", text: "System Status indicator in the sidebar now shows amber 'In Development' instead of green 'All services operational'." },
    ],
  },
  {
    version: "1.0.565",
    date: "26 May 2026",
    items: [
      { category: "Fix", text: "Clicking Login in the embedded browser panel no longer marks the account as Valid. The browser login now only saves the session cookies — the account status is only updated to Valid when you explicitly click Verify Credentials." },
    ],
  },
  {
      version: "1.0.559",
      date: "26 May 2026",
      items: [
        { category: "Feature", text: "Create a Ghost: the proxy selector now has an \"Add Proxy\" option at the bottom of the dropdown — selecting it reveals inline IP/Host, Port, Username, and Password fields so you can use a custom proxy without adding it to Proxy Manager first." },
        { category: "Fix", text: "Create a Ghost: \"Start from Fresh\" now also picks a new random device identity (user-agent) alongside wiping all cookies and cache, giving a completely clean slate for each new account attempt." },
        { category: "Fix", text: "Create a Ghost: the ghost browser stream now stays live through the full Instagram signup flow — the screencast automatically reconnects after each page navigation (e.g. signup form → email verification), so the browser no longer appears to crash mid-signup." },
        { category: "Fix", text: "Create a Ghost: if Chrome disconnects unexpectedly (OOM or force kill), the browser panel now shows a clear message instead of freezing on the last frame forever." },
        { category: "Fix", text: "Create a Ghost: Replit preview panel refreshes no longer reset the browser to \"not started\" — on page load the app checks whether the ghost browser is still running and reconnects automatically." },
      ],
    },
  {
    version: "1.0.558",
    date: "26 May 2026",
    items: [
      { category: "Fix", text: "Create an Account: the embedded browser no longer shows a constantly-refreshing page on the second and subsequent attempts — the screencast now starts after the page has fully loaded, preventing a silent failure that was causing Chrome to receive no frame data." },
      { category: "Fix", text: "Create an Account: rapidly clicking Randomise multiple times no longer sends multiple browser-close requests — a ref-based guard now ensures only one reset runs at a time regardless of how fast the button is clicked." },
      { category: "Fix", text: "Create an Account: the browser address bar now updates as Instagram navigates between pages (login, signup, challenge) so you can see exactly where the browser has landed." },
    ],
  },
  {
    version: "1.0.557",
    date: "26 May 2026",
    items: [
      { category: "Fix", text: "Create an Account: the embedded browser no longer refreshes/navigates on its own when it first opens — the automatic cookie banner click that was triggering Instagram redirects has been removed. The banner can be dismissed with a single manual click." },
      { category: "Fix", text: "Create an Account: background cookie-harvest operations no longer disrupt the visible browser stream — they now use their own private browser instance and no longer interfere with what you see in the panel." },
    ],
  },
  {
    version: "1.0.556",
    date: "26 May 2026",
    items: [
      { category: "Feature", text: "Accounts page: column headers can now be dragged and dropped to rearrange the column order, matching the behaviour on the Statistics page." },
      { category: "Fix", text: "Dashboard, Accounts, Proxy Manager, and Statistics pages: removed the hand/grab cursor that appeared when hovering over column headers — the normal pointer cursor is now used instead." },
    ],
  },
  {
    version: "1.0.555",
    date: "26 May 2026",
    items: [
      { category: "Fix", text: "Device picker: the picker now shows the correct 86 curated devices instead of a 1,000-entry list with hundreds of duplicate Samsung models." },
      { category: "Fix", text: "Create Account browser: reduced the cookie-banner dismissal loop from 10 rapid retries to 2 spaced attempts so accepting cookies no longer triggers constant page refreshing." },
      { category: "Fix", text: "Embedded browser: mouse movement is now throttled to 20 updates per second — previously the unthrottled mousemove flood could jam Puppeteer's command queue and cause Chrome to become unresponsive after a few minutes of use." },
    ],
  },
  {
    version: "1.0.554",
    date: "26 May 2026",
    items: [
      { category: "Feature", text: "Account Settings: the API User Agent field is now a device picker grouped by brand — expand any brand to choose from all available models." },
      { category: "Feature", text: "When you pick a device, both the API and embedded browser user agents are updated together automatically so they always match." },
      { category: "Feature", text: "Picking a device shows a confirmation prompt and, on approval, fully resets the device identity — clears Device IDs, logs out the embedded browser session, and wipes all cookies so the account starts as a clean device." },
      { category: "Fix", text: "Jarvee binary import: passwords were being imported incorrectly — fixed the field order detection so proxy passwords are no longer imported as Instagram passwords." },
      { category: "Fix", text: "Jarvee binary import: 2FA secrets exported in grouped format (e.g. AAAA BBBB CCCC) are now correctly imported with spaces stripped." },
      { category: "Fix", text: "Create Account embedded browser: removed a macro that was causing the browser to constantly refresh and redirect after accepting cookies." },
    ],
  },
  {
    version: "1.0.553",
    date: "26 May 2026",
    items: [
      { category: "Fix", text: "Create Account: the embedded browser now browses the Instagram homepage and explore page for ~60–90 seconds before signup, giving the device organic session history that Instagram requires before trusting a new account." },
      { category: "Fix", text: "Create Account: all signup API calls now use the Android OkHttp4 TLS fingerprint instead of Node.js — eliminates the server-software TLS signal that caused Instagram to flag the environment as unrecognised." },
    ],
  },
  {
    version: "1.0.552",
    date: "26 May 2026",
    items: [
      { category: "Fix", text: "Create Account: the embedded browser now visits Instagram as a mobile Android device instead of a Windows desktop, so device cookies match the Android API signup calls." },
      { category: "Fix", text: "Create Account: bandwidth headers now report a realistic WiFi speed instead of the placeholder values that bot-detection flags." },
      { category: "Fix", text: "Create Account: timezone offset header now matches the proxy IP's country — Instagram cross-checks this against the connecting IP address." },
      { category: "Fix", text: "Create Account: missing locale headers added to every signup API request to match what a real Android Instagram app sends." },
      { category: "Fix", text: "Create Account: when the library fallback runs it now reuses the same device IDs from the embedded browser session instead of creating a brand-new device fingerprint mid-flow." },
    ],
  },
  {
    version: "1.0.551",
    date: "26 May 2026",
    items: [
      { category: "Fix", text: "Human Sessions: skip chance now works correctly — setting 75–100% skips the action 75–100% of the time instead of running it that often." },
      { category: "Fix", text: "Account Settings: Generate Code button now shows the full 6-digit TOTP code (e.g. Copied! 123456) for 10 seconds before returning to its default label." },
      { category: "Change", text: "Create Account: replaced the automated macro flow with a fully manual embedded-browser workflow — open the browser, navigate to Instagram, then use the clipboard icons next to each field to paste spun/sanitised values directly into the focused field." },
    ],
  },
  {
    version: "1.0.549",
    date: "25 May 2026",
    items: [
      { category: "Fix", text: "Create Account: the automation was silently doing nothing after clicking Create — the two server routes that run the headless signup browser were completely missing and have now been added." },
      { category: "Fix", text: "Create Account: step-by-step progress messages (navigating, filling form, detecting gate page, etc.) now appear in the live trace panel as the automation runs." },
      { category: "Fix", text: "Create Account: entering the email verification code and clicking Confirm now correctly resumes the paused automation instead of returning an error." },
    ],
  },
  {
    version: "1.0.548",
    date: "25 May 2026",
    items: [
      { category: "Fix", text: "Import Binary File: the account label (Name field from Jarvee) is now imported and shown as the account label in Equinox instead of being silently dropped." },
      { category: "Fix", text: "Import Binary File: the recovery email address and its password are now correctly imported into the Email Validation fields." },
      { category: "Fix", text: "Import Binary File: the 2FA secret key is now extracted from the binary and saved to the account's 2FA Secret Key field." },
    ],
  },
  {
    version: "1.0.547",
    date: "25 May 2026",
    items: [
      { category: "Fix", text: "Create Account: the signup form now always opens in a completely clean browser — no cookies, cache, or history from a previous attempt can carry over, even if the last attempt crashed mid-way." },
      { category: "Fix", text: "Create Account: the EB no longer stalls on the homepage waiting for a Sign Up button — it seeds device cookies then navigates directly to the email signup form, cutting the wait from 60+ seconds to a few seconds." },
    ],
  },
  {
    version: "1.0.546",
    date: "25 May 2026",
    items: [
      { category: "Fix", text: "Create Account: the browser no longer hangs for 10 seconds between signup steps — each stage now waits for the next element to actually appear on the page instead of using a fixed timer." },
      { category: "Fix", text: "Create Account: pressing Randomise then immediately pressing Create Account no longer loads the previous browser session — the Create Account button stays disabled until the reset fully completes." },
    ],
  },
  {
    version: "1.0.545",
    date: "25 May 2026",
    items: [
      { category: "Fix", text: "Statistics page: column sort arrows now toggle between ascending and descending only — clicking a sorted column no longer resets it to unsorted as a third state." },
      { category: "Improvement", text: "Dashboard activity log now loads noticeably faster — the feed is capped at 2,000 entries and only renders the most recent 500 rows at a time, eliminating the slowdown caused by thousands of DOM rows." },
    ],
  },
  {
    version: "1.0.545",
    date: "26 May 2026",
    items: [
      { category: "Fix", text: "Login button in the embedded browser now only harvests session cookies from Chrome — it no longer runs the mobile API verification step or sets the account to Active. You must click Verify after logging in to activate automation, as intended." },
    ],
  },
  {
    version: "1.0.544",
    date: "25 May 2026",
    items: [
      { category: "Fix", text: "Tools: toggling a tool off and back on now immediately clears any active block suspension — the tool retries straight away instead of waiting out the remainder of a 24- or 50-hour pause." },
      { category: "Fix", text: "Create Account: the Randomise button now generates a fresh password, date of birth, and first name alongside the new device fingerprint — every press produces a fully new identity." },
      { category: "Fix", text: "Accounts page: opening the embedded browser now triggers auto-login even when Chrome loads Instagram's home page (existing cookies) — previously auto-login only fired when Chrome opened directly on the login form." },
    ],
  },
  {
    version: "1.0.543",
    date: "25 May 2026",
    items: [
      { category: "Fix", text: "Create Account: after 'Sign up' is clicked and Instagram shows the phone-number form, the browser now automatically clicks 'Sign up with email address' to reach the email form — the process no longer stops at the mobile-number prompt." },
      { category: "Fix", text: "Create Account: the Randomise button now fully resets the tool — the 'Create Account' button at the bottom is no longer stuck on 'Creating Account…' after clicking Randomise following a failed attempt." },
      { category: "Fix", text: "Electron EB: auto-login now uses a DOM MutationObserver so the username/password form is filled the instant it appears in the page — no longer misses it due to timing." },
    ],
  },
  {
    version: "1.0.542",
    date: "25 May 2026",
    items: [
      { category: "Fix", text: "Create Account: after the cookie banner is accepted, the browser now clicks the 'Sign up' or 'Create an account' button automatically before filling the form — works correctly regardless of which user agent model is selected." },
      { category: "Fix", text: "Create Account: if no Sign Up button is found on the homepage (e.g. on certain mobile UAs), the browser falls back to navigating directly to the email signup form so the process never gets stuck." },
      { category: "Fix", text: "Create Account: the streaming browser panel now also navigates to the signup form after cookie dismiss so you can watch the process live." },
      { category: "Fix", text: "Randomise button at the top of the Create Account page is no longer greyed out while an account is being created — it can always be clicked." },
    ],
  },
  {
    version: "1.0.541",
    date: "25 May 2026",
    items: [
      { category: "Fix", text: "Electron embedded browser now reliably auto-fills and submits the Instagram login form — credentials are injected directly into the page on every load so SPA navigations and inline login forms are handled correctly." },
      { category: "Fix", text: "Cookie banner is dismissed first, then the login form is filled — both steps run in the same page context so the sequence is always correct regardless of how Instagram presents the login UI." },
      { category: "Fix", text: "Create Account browser now automatically dismisses the cookie consent banner as soon as it appears after the Instagram page loads." },
      { category: "Fix", text: "Embedded browser no longer shows the 'Browser appears frozen' overlay when sitting idle — the threshold has been raised to 10 minutes." },
      { category: "Fix", text: "Clear / Reset session button in the browser toolbar is now always clickable, even when the browser is not connected." },
    ],
  },
  {
    version: "1.0.540",
    date: "25 May 2026",
    items: [
      { category: "Fix", text: "Previous auto-login attempt — superseded by 1.0.541 fix." },
    ],
  },
  {
    version: "1.0.539",
    date: "25 May 2026",
    items: [
      { category: "Fix", text: "Login button in the embedded browser toolbar now works — clicking it fills the username and password and submits the form." },
      { category: "Fix", text: "Cookie consent banner is now dismissed in under a second instead of waiting up to 8 seconds." },
      { category: "Fix", text: "Login button also dismisses the cookie banner before filling the form so the submit click is never blocked." },
      { category: "Improvement", text: "Reload and Home buttons in the browser toolbar are now the same compact size as all other buttons." },
      { category: "Improvement", text: "Home button now shows a house icon instead of the old compass/navigation icon." },
      { category: "Improvement", text: "All toolbar buttons now use a consistent grey colour scheme — no more coloured emoji icons." },
      { category: "New", text: "Browser toolbar now has a tab bar — press + to open a new Google tab inside the same browser window, switch between tabs by clicking them, and close extra tabs with the × button." },
    ],
  },
  {
    version: "1.0.550",
    date: "25 May 2026",
    items: [
      { category: "Fix", text: "Create an Account: fixed the 'Sign up with email' button click — the code was clicking the centre of the form instead of the actual link because parent containers were being matched by mistake. The correct link is now found and clicked reliably." },
      { category: "Fix", text: "Create an Account: switched from old headless Chrome mode to the new headless mode which is much harder for Instagram to detect as a bot." },
      { category: "Fix", text: "Create an Account: stealth scripts (hide automation fingerprints) are now applied before the browser visits Instagram, so the signup session looks like a real Chrome browser from the first request." },
      { category: "Fix", text: "Create an Account page subheader no longer incorrectly says 'via the mobile API' — account creation is entirely through the embedded browser." },
    ],
  },
  {
    version: "1.0.538",
    date: "25 May 2026",
    items: [
      { category: "New", text: "Create an Account page now shows an embedded browser panel on the right side of the form — you can watch the signup happen live as it types each field." },
      { category: "New", text: "Clicking Create Account now drives the embedded browser through the full Instagram signup flow automatically: cookies, email entry, verification code pause, password, date of birth, name, username, and terms." },
      { category: "New", text: "Email verification step pauses the automation and shows the code input box — enter the 6-digit code and hit Submit to resume the browser." },
      { category: "New", text: "Created accounts are stored in the database and visible on the Created Accounts tab with options to add them to your main accounts list." },
    ],
  },
  {
    version: "1.0.533",
    date: "25 May 2026",
    items: [
      { category: "Fix", text: "Jarvee import now correctly assigns the Chrome user agent to the embedded browser instead of the API client." },
      { category: "New", text: "Jarvee import now restores the follow tool source list — all target accounts whose followers you were following are imported automatically." },
      { category: "New", text: "Jarvee import now restores the followed users dedup list so Equinox won't re-follow anyone already followed in Jarvee." },
      { category: "New", text: "Jarvee import now restores the DM recipients list so Equinox won't re-DM anyone already messaged in Jarvee." },
    ],
  },
    {
      version: "1.0.537",
      date: "25 May 2026",
      items: [
        { category: "Fix", text: "Sessions no longer expire while automation is running. After every follow, unfollow, DM, and contact cycle the app now saves the refreshed session token back to the database — exactly the way Jarvee kept accounts permanently alive. Accounts that were running tools daily should never need a manual re-verify again." },
      ],
    },
    {
      version: "1.0.536",
      date: "25 May 2026",
      items: [
        { category: "Fix", text: "Verify Credentials no longer falsely reports 'Automated Behaviour Detected' when the mobile API session is expired. If Instagram's session probe returns inconclusive (endpoint not available) and follow-up calls return 403, the account is now correctly marked as 'Logged Out' instead — open the embedded browser and re-verify to refresh it." },
      ],
    },
    {
      version: "1.0.535",
      date: "25 May 2026",
      items: [
        { category: "Fix", text: "Follow tool no longer reports 'blocked' when it was actually receiving a compressed (gzip) response from Instagram — the API transport now always requests uncompressed responses so follow calls are parsed correctly." },
        { category: "Fix", text: "Follow tool sessions that had no active session (account not yet verified in the browser) now show a clear 'No active session — verify the account' message in the activity log instead of the misleading 'nothing to do'." },
      ],
    },
    {
      version: "1.0.534",
      date: "25 May 2026",
      items: [
        { category: "Fix", text: "View Timeline Feed — Like% now works correctly. Setting 5% no longer always likes at least 1 post; it now likes proportionally (e.g. 5% of 5 posts = 0 likes most of the time, 1 like occasionally)." },
        { category: "New", text: "View Timeline Feed — new Reel View% setting. Set a min/max percentage of each reel's length to watch (e.g. 10–15% of a 60-second reel = 6–9 seconds watched). Leave at 0% to use the previous default behaviour." },
        { category: "Fix", text: "Account name in the profile picker dropdown no longer gets cut off with '...' — the button now sizes to fit the full name." },
      ],
    },
    {
      version: "1.0.532",
      date: "25 May 2026",
      items: [
        { category: "Tweak", text: "Moved Import Binary File above Import EQX File in the Actions menu." },
      ],
    },
  {
    version: "1.0.531",
    date: "25 May 2026",
    items: [
      { category: "New", text: "Import Binary File — you can now import Jarvee account export files directly from the Actions menu. Equinox reads the username, password, proxy, and device info from the file and creates the account as Pending ready to verify." },
    ],
  },
  {
    version: "1.0.530",
    date: "25 May 2026",
    items: [
      { category: "Fix", text: "Check Direct Messages now works — the DM inbox was getting a 400 error because the Instagram API client library sends a different set of headers than Instagram expects. Switched to the same transport used by all other working mobile API calls." },
      { category: "Fix", text: "Auto-reply DM scanning (getDMThreadsWithContent) had the same inbox 400 issue and is also fixed." },
    ],
  },
  {
    version: "1.0.529",
    date: "24 May 2026",
    items: [
      { category: "Fix", text: "Session-expired blocks (\"session expired — re-verify account\") now immediately stop the follow session and mark the account logged out, instead of being silently ignored and triggering 20 rounds of re-scraping." },
      { category: "Fix", text: "The re-scrape loop now aborts as soon as all follow slots have been consumed by blocks with no successful follows — prevents pointless re-scraping when the account is dead or action-blocked." },
      { category: "Fix", text: "Stop Tool if Blocked now activates for all block types, including unexpected responses (e.g. \"200 undefined\") — previously it only fired for the specific Instagram block messages." },
    ],
  },
  {
    version: "1.0.528",
    date: "24 May 2026",
    items: [
      { category: "Fix", text: "Check DMs now runs even when the View Timeline Feed or Like Posts action detects a web-session expiry — the DM check uses a separate mobile API path that can still succeed independently." },
      { category: "Fix", text: "The Login button in the embedded browser now polls for the username and password fields instead of checking once — handles pages where the form takes a moment to appear." },
      { category: "Fix", text: "Clicking Login when not on the Instagram login page now navigates there and fills the form automatically with fresh credentials after the page loads, instead of leaving the fields empty." },
    ],
  },
  {
    version: "1.0.527",
    date: "24 May 2026",
    items: [
      { category: "Improvement", text: "Account verification now makes one fewer API call — the GetUserProfile lookup has been removed from the login sequence entirely." },
    ],
  },
  {
    version: "1.0.526",
    date: "24 May 2026",
    items: [
      { category: "Fix", text: "Create Account now uses the real browser (Chrome) to fill and submit Instagram's signup form instead of calling the mobile API — this bypasses the 'signup_block / spam' error that Instagram was returning for API-based requests." },
      { category: "Fix", text: "Email verification during account creation is now handled end-to-end in the same browser session — the code is submitted directly into the live Chrome page, so the signup completes without needing to restart." },
      { category: "Improvement", text: "The mobile API remains as an automatic fallback if Chrome cannot be launched or the form layout cannot be detected, so account creation still works even in edge cases." },
    ],
  },
  {
    version: "1.0.525",
    date: "24 May 2026",
    items: [
      { category: "Fix", text: "Create Account now uses Instagram app version 431 — the previous version (428) was being rejected by Instagram as too old." },
      { category: "Fix", text: "The library fallback during account creation is now also patched to use version 431, so all three signup paths send a consistent, current app version." },
      { category: "Improvement", text: "Every signup attempt now writes a full diagnostic entry to the server log — all steps and the raw Instagram response are recorded, making it possible to see exactly what Instagram returned." },
    ],
  },
  {
    version: "1.0.524",
    date: "24 May 2026",
    items: [
      { category: "Fix", text: "Account creation now uses standard Node.js HTTPS for all signup API calls instead of the Android OkHttp4 transport — eliminates the TLS fingerprint mismatch that was triggering Instagram's bot detection on the create-account endpoint." },
      { category: "Fix", text: "The library fallback path during account creation no longer applies the Android TLS transport either, giving it a genuinely different network path from the primary attempts." },
      { category: "Fix", text: "The web registration fallback now also uses standard HTTPS, fixing the mismatch between a Chrome User-Agent and an Android TLS fingerprint on that request." },
    ],
  },
  {
    version: "1.0.523",
    date: "24 May 2026",
    items: [
      { category: "Fix", text: "Create Account errors now show exactly what Instagram returned instead of a generic message — no more guessing about proxies or giving advice that doesn't match the actual rejection reason." },
    ],
  },
  {
    version: "1.0.522",
    date: "24 May 2026",
    items: [
      { category: "Fix", text: "Create Account no longer blames the proxy when Instagram rejects the signup — the proxy warning now only appears if the warm-up network calls actually fail with a connection error, not just because Instagram returned no cookies (which is normal)." },
    ],
  },
  {
    version: "1.0.521",
    date: "24 May 2026",
    items: [
      { category: "Fix", text: "Copy Settings no longer shows a phantom selected count — stale account IDs left in storage from deleted or renamed accounts are now cleaned up automatically when the dialog opens." },
      { category: "Fix", text: "Create Account now shows a clear, actionable error message when Instagram rejects the signup — if the proxy blocked the warm-up calls entirely you are told to try a different proxy; otherwise you are told to wait a few minutes and retry." },
    ],
  },
  {
    version: "1.0.520",
    date: "24 May 2026",
    items: [
      { category: "Fix", text: "Create Account no longer stops at the first 'Bad request' response from Instagram — it now tries the library fallback and web registration fallback paths before giving up, matching the retry behaviour that applies to all other generic 400 responses." },
      { category: "Fix", text: "Fixed a second instance of the CycleTLS .data vs .body bug in the multipart photo upload path — responses were being read from the wrong field and silently returning null." },
    ],
  },
  {
    version: "1.0.519",
    date: "24 May 2026",
    items: [
      { category: "Fix", text: "Account creation error messages now show the actual text from Instagram instead of a raw binary blob — CycleTLS was returning responses as a Buffer object which got serialised as JSON bytes instead of readable text." },
      { category: "Fix", text: "CycleTLS (Android TLS fingerprinting) is now a proper dependency of the API server — it was only installed inside the Electron package so the server could not find it and silently fell back to standard Node.js TLS on every request." },
    ],
  },
  {
    version: "1.0.518",
    date: "24 May 2026",
    items: [
      { category: "Fix", text: "Fixed the Android TLS fingerprint (CycleTLS) so it now actually makes requests — it was advertising a TLS extension in the handshake (compress_certificate, ext 98) that its own library cannot handle, causing every request to fail before connecting and fall back to standard TLS." },
      { category: "Feature", text: "Column headers FOLLOWERS, FOLLOWING, and SYNC are now displayed in uppercase in the accounts table." },
      { category: "Feature", text: "Follow tool: added 'Enable Automatic Unfollows' — set a followings count threshold (X–Y); when synced followings reaches it, the follow tool is disabled and the unfollow tool is activated automatically." },
      { category: "Feature", text: "Follow tool: added 'Activate tool after X–Y minutes' checkbox to stagger the activation of the unfollow tool when the threshold is hit." },
      { category: "Feature", text: "Unfollow tool: added 'Enable Automatic Follows' — set a followings count threshold (X–Y); when synced followings drops to it, the unfollow tool is disabled and the follow tool is activated automatically." },
      { category: "Feature", text: "Unfollow tool: added 'Activate tool after X–Y minutes' checkbox to stagger the activation of the follow tool when the threshold is hit." },
      { category: "Fix", text: "Fixed the root cause of the Android TLS fingerprint never being used: the library changed its response format in a recent update (body moved from .body to .data) and our code was reading the wrong field, so the fingerprint was always silently bypassed and fell back to standard TLS for every request." },
      { category: "Fix", text: "The actual error from the TLS library is now shown in the log when it fails, instead of always showing '(empty)' — this will finally reveal what the proxy is rejecting." },
      { category: "Fix", text: "Sync now writes each call to the API calls export file, including whether the data came from HikerAPI or the account's own session." },
      { category: "Fix", text: "The Android TLS fingerprint library can now route through proxies that do SSL inspection — it was rejecting the proxy's certificate and silently falling back to standard Node.js TLS on every request, which is why needs_upgrade kept appearing despite the fingerprint being loaded." },
      { category: "Fix", text: "Fixed a crash introduced in v1.0.514 that broke every signup attempt — the new debug logging code called .slice() on an undefined value, which crashed every TLS call before any request could reach Instagram." },
      { category: "Fix", text: "When the Android TLS fingerprint library fails to route through a proxy, the exact error from the underlying library is now logged — this will show whether it is a proxy authentication issue, a connection refusal, or something else, so the root cause can be fixed directly." },
      { category: "Fix", text: "CycleTLS is now a proper dependency of the Windows app — it was being copied into the wrong folder inside the build and then not found at runtime. It now installs via npm alongside the other app dependencies so the Android TLS fingerprint is active from first launch." },
      { category: "Fix", text: "Profile Sync no longer always returns 'Sync Failed' — the mobile session was not being initialised from stored cookies before the stats fetch, so every sync request returned null." },
      { category: "Fix", text: "The 'app version too old' error message no longer says to rebuild and redeploy — that was a leftover dev note; the message now tells you to switch proxy or retry." },
      { category: "Fix", text: "The device UA picker on Create an Account now only draws from Android 14+ profiles, matching the server-side selection." },
    ],
  },
  {
    version: "1.0.510",
    date: "24 May 2026",
    items: [
      { category: "Fix", text: "Fixed the capabilities header sent during account creation — the old value was flagging the request as an outdated app version even though the version number itself was already correct." },
      { category: "Fix", text: "Account creation now only uses Android 14+ device profiles — mixing Instagram 428 with an Android 13 device string was another trigger for the 'needs_upgrade' rejection." },
      { category: "Fix", text: "Updated the fallback mobile device profile to Android 14 to keep all mobile API calls internally consistent." },
    ],
  },
  {
    version: "1.0.509",
    date: "24 May 2026",
    items: [
      { category: "Fix", text: "Resolved 'Update Instagram to sign up' error — the app version used for account creation has been updated to Instagram 428 (the current version Instagram accepts for mobile signup)." },
      { category: "Fix", text: "Updated the Bloks version ID to match Instagram 428 — a mismatch between these two values also triggers the needs_upgrade rejection from Instagram's signup backend." },
    ],
  },
  {
    version: "1.0.508",
    date: "24 May 2026",
    items: [
      { category: "Fix", text: "Account creation requests now include the X-Pigeon-Session-Id and X-Pigeon-Rawclienttime headers that the real Instagram app sends on every call — without these, Instagram's bot detection is more likely to fire the signup_block error." },
      { category: "Fix", text: "The signup request body now includes phone_id and client_id fields, matching what the real Instagram Android app sends when creating an account." },
      { category: "Fix", text: "Added X-IG-Connection-Speed header to signup requests to complete the standard Android API header set." },
    ],
  },
  {
    version: "1.0.507",
    date: "24 May 2026",
    items: [
      { category: "Fix", text: "Create an Account no longer fails silently when the proxy blocks Chrome's CDN requests — real Instagram cookies (csrftoken, mid, ig_did) are now harvested from the browser using a default Chrome user agent when none is configured for the account yet." },
      { category: "Fix", text: "All API calls during account creation now retry via the standard HTTPS stack when the CycleTLS connection returns empty (proxy blocking the Go subprocess) — previously every step returned HTTP 0 and signup always aborted." },
      { category: "New", text: "API Step Timing controls are now visible on the Create an Account form — set Min/Max Calls and Min/Max seconds to control the delay between each signup API step. Defaults to 5–30 seconds to avoid Instagram rate-limit blocks." },
      { category: "Fix", text: "API step delays were previously silently disabled (no-op) when no timing was configured. A safe 5–15 second minimum delay is now always enforced between each signup step." },
    ],
  },
  {
    version: "1.0.506",
    date: "24 May 2026",
    items: [
      { category: "Fix", text: "Create an Account now has an Email Address field — it was missing, causing every signup attempt to fail immediately with a validation error." },
      { category: "Change", text: "Email is now a required field on the Create an Account page. Instagram sends the verification code to this address during signup." },
    ],
  },
  {
    version: "1.0.505",
    date: "24 May 2026",
    items: [
      { category: "Change", text: "Removed the Phone Auto-Verify panel from the Create an Account page — phone verification is no longer used for email-based signups." },
      { category: "New", text: "When Instagram asks for an email verification code during account creation, a clear amber prompt now appears with a large code input box so you can enter the code and continue without starting over." },
    ],
  },
  {
    version: "1.0.504",
    date: "24 May 2026",
    items: [
      { category: "Fix", text: "CycleTLS (OkHttp4 Android TLS fingerprint) now loads correctly in the installed app — the Go binary was never being included in the installer, causing every session to silently fall back to Node.js TLS with no Android fingerprint." },
    ],
  },
  {
    version: "1.0.503",
    date: "24 May 2026",
    items: [
      { category: "Fix", text: "Verify no longer shows 'FetchConfig 400 Invalid experiment' errors — the outdated experiment list sent to Instagram has been replaced with a minimal config-only request that Instagram accepts correctly." },
      { category: "Fix", text: "Updated the BLOKS version ID used during verify and login to match the current app version, removing a mismatch that could cause Instagram to flag requests." },
    ],
  },
  {
    version: "1.0.502",
    date: "24 May 2026",
    items: [
      { category: "Improvement", text: "Account creation step panel now shows full detail from the cookie harvest phase — Chrome launch status, proxy used, UA applied, and cookie detection result after each page visit." },
      { category: "Improvement", text: "Server debug log is now written to disk (equinox-debug.log next to your database) and is viewable and downloadable from the Settings page without needing DevTools." },
    ],
  },
  {
    version: "1.0.501",
    date: "24 May 2026",
    items: [
      { category: "Fix", text: "Embedded browser toolbar changes (bigger Reload/Home buttons, compass icon, monochrome buttons, Google new tab) now correctly apply to the Windows native browser window — the previous version only updated the web panel." },
    ],
  },
  {
    version: "1.0.500",
    date: "24 May 2026",
    items: [
      { category: "Improvement", text: "Embedded browser toolbar: Reload and Home buttons are now larger and more prominent for easier access." },
      { category: "Improvement", text: "Embedded browser Home button icon updated to a compass — clearer navigation symbol." },
      { category: "Improvement", text: "Login, 2FA, Phone, Email, and Email Password buttons in the embedded browser toolbar are now clean black and white — no more coloured states." },
      { category: "Improvement", text: "New tab button (+) now opens a built-in tab inside the browser panel, landing on Google.com instead of Instagram." },
      { category: "Improvement", text: "Accounts column sort icons changed from shuffle-style arrows to clear up/down arrows so they no longer look like a randomiser." },
      { category: "Improvement", text: "CycleTLS OkHttp4 fingerprinting now active — all Instagram API calls use an Android device TLS profile for improved session security." },
    ],
  },
  {
    version: "1.0.499",
    date: "23 May 2026",
    items: [
      { category: "Improvement", text: "Copy Settings button for every tool (Follow, Unfollow, Contact, Human Session, Cookie Baker) now appears in the top nav bar — same position as Account Settings — instead of buried inside the tool panel." },
      { category: "Fix", text: "Verify button stays visible and shows a spinner during verification instead of disappearing, preventing confusion about whether the click was registered." },
      { category: "Fix", text: "Fixed a race condition where verification could get stuck showing 'Verifying' permanently due to a competing status update." },
      { category: "Improvement", text: "Accounts page now shows Followers, Following, and Last Sync columns with sortable headers." },
    ],
  },
  {
    version: "1.0.498",
    date: "23 May 2026",
    items: [
      { category: "Fix", text: "Active toggle in the Accounts page now responds instantly instead of appearing frozen after clicking." },
      { category: "Fix", text: "Accounts imported from EQX files that were in a stopped state can now be re-activated correctly." },
      { category: "Fix", text: "No account can now run tools, sync stats, bake cookies, fix ABD, or open the browser without a proxy assigned — your home IP can no longer be used." },
      { category: "Fix", text: "Active toggle and Browser button in the Accounts page are now disabled for accounts that have no proxy, with a tooltip explaining why." },
      { category: "Fix", text: "Copy Settings now remembers the last selected accounts across all tools — selecting accounts in one tool's Copy Settings is reflected when opening Copy Settings from any other tool." },
    ],
  },
  {
    version: "1.0.497",
    date: "23 May 2026",
    items: [
      { category: "Fix", text: "Embedded browser toolbar is now a native window overlay — it can no longer be hidden by challenge pages, iframes, or anything Instagram's page does." },
      { category: "Fix", text: "Opening the embedded browser now goes straight to the login page when no active session exists, so the auto-fill fires immediately without extra clicks." },
    ],
  },
  {
    version: "1.0.496",
    date: "23 May 2026",
    items: [
      { category: "Improvement", text: "Import Proxies button added next to Add Proxy — paste a list of proxies in ip:port or ip:port:username:password format to bulk import them instantly." },
      { category: "Fix", text: "Accounts cleared of their proxy now correctly appear as unassigned in the Proxy Manager, so the Split function can assign them to proxies again." },
      { category: "Fix", text: "Deleting a proxy now automatically clears the proxy assignment from all accounts that were using it." },
      { category: "Removed", text: "Auto-link button removed from the Proxy Manager." },
    ],
  },
  {
    version: "1.0.495",
    date: "23 May 2026",
    items: [
      { category: "Fix", text: "Clear Data button on Create an Account now actually closes the signup browser and wipes all its cookies and session storage." },
      { category: "Improvement", text: "Clear Data button is now a bin icon instead of a refresh icon so it's obvious what it does." },
      { category: "Improvement", text: "Randomise now also clears the signup browser session — since you're picking a new device, the old cookies don't belong to it." },
      { category: "Improvement", text: "Device card now shows the API UA string alongside the browser UA so you can see both at a glance." },
    ],
  },
  {
    version: "1.0.494",
    date: "23 May 2026",
    items: [
      { category: "Fix", text: "Signup browser now opens a proper native Chrome window exactly like the Accounts EB — no streaming, no workarounds, just the real thing." },
    ],
  },
  {
    version: "1.0.493",
    date: "23 May 2026",
    items: [
      { category: "Fix", text: "Signup browser now actually streams live in the Electron app — the stream was silently skipped in Electron mode even when a server-side browser was running." },
    ],
  },
  {
    version: "1.0.492",
    date: "23 May 2026",
    items: [
      { category: "Feature", text: "Signup browser now launches a real Puppeteer browser on the server when you click 'Open Browser' — it boots Chrome, loads instagram.com, and streams it live." },
      { category: "Feature", text: "Signup browser window has proper Windows-style controls: minimise collapses to just the title bar, maximise fills the whole screen, close shuts the window." },
      { category: "Feature", text: "Reset button (↺) next to Open Browser closes the browser and wipes its session data so you can start fresh." },
    ],
  },
  {
    version: "1.0.491",
    date: "23 May 2026",
    items: [
      { category: "Fix", text: "Signup browser now shows the live Instagram stream instead of a blank placeholder — you can interact with it directly in the window." },
      { category: "Fix", text: "Signup browser window now drags freely anywhere on screen without snapping to edges." },
      { category: "Fix", text: "Removed the pointless 'Bring to Front' button from the signup browser toolbar." },
    ],
  },
  {
    version: "1.0.490",
    date: "23 May 2026",
    items: [
      { category: "Improvement", text: "Proxy Manager now remembers the column you sorted by when you leave and return to the page." },
      { category: "Improvement", text: "Statistics page now remembers its sort column and direction when you navigate away and come back." },
      { category: "Improvement", text: "Accounts page sort order is already remembered per session — no change needed." },
    ],
  },
  {
    version: "1.0.489",
    date: "23 May 2026",
    items: [
      { category: "New", text: "Added 'Create an Account' to the sidebar so it is always one click away." },
      { category: "New", text: "Added SMS-man.com auto-verify — when Instagram asks for phone verification, a temp number is auto-requested and the SMS code auto-filled." },
      { category: "New", text: "Added 5sim.net as a second phone verification provider — switch between SMS-man and 5sim with a single click in the Phone Auto-Verify card." },
      { category: "Removed", text: "Removed the Watch EB button and embedded browser live panel from the Create Account page." },
      { category: "Removed", text: "Removed the Email and IMAP fields from the Create Account page — phone-based verification via SMS-man or 5sim is now the only auto-verify method." },
    ],
  },
  {
    version: "1.0.488",
    date: "23 May 2026",
    items: [
      { category: "Removed", text: "Removed the USB Hotspot / phone tethering relay feature entirely." },
    ],
  },
  {
    version: "1.0.486",
    date: "23 May 2026",
    items: [
      { category: "Fix", text: "Fixed a build error that prevented the installer from being created — the Windows routing fix function was missing the async keyword." },
    ],
  },
  {
    version: "1.0.485",
    date: "23 May 2026",
    items: [
      { category: "Fix", text: "The 'Fix routing' button now works correctly — it uses the right Windows command (netsh interface ipv4) and also tries PowerShell as a fallback, so the metric change reliably applies." },
      { category: "Fix", text: "The warning banner and Fix routing button no longer appear for your regular WiFi adapter — they now only show for the USB-tethered phone adapter." },
    ],
  },
  {
    version: "1.0.484",
    date: "23 May 2026",
    items: [
      { category: "Fix", text: "Plugging in a USB-tethered phone no longer reroutes your entire computer's internet through it — Equinox now automatically sets a high routing metric on the phone adapter the moment the relay starts, so Windows keeps using your main connection for everything else." },
      { category: "New", text: "A warning banner now appears in the USB Hotspot panel whenever a phone adapter is detected, with a 'Fix routing' button in case the automatic fix needs a retry or admin rights." },
    ],
  },
  {
    version: "1.0.483",
    date: "23 May 2026",
    items: [
      { category: "Fix", text: "Embedded browser no longer gets stuck on the 'Starting browser...' spinner when Instagram shows a lock, checkpoint, or challenge page — the overlay now clears as soon as Chrome renders anything, even a blank white page." },
      { category: "Improved", text: "Browser navigation buttons (back, forward, refresh, home) now use cleaner, crisper icons." },
      { category: "Improved", text: "Battery percentage colour now only turns orange below 25% and red below 5%, so most accounts stay green throughout normal operation." },
      { category: "Fix", text: "Hotspot accounts can now open the embedded browser and verify without being blocked by the 'no proxy assigned' guard — the relay is the proxy." },
    ],
  },
  {
    version: "1.0.482",
    date: "23 May 2026",
    items: [
      { category: "Improved", text: "The 'no adapter found' message in the Hotspot panel now explains step-by-step how to get USB tethering working on both iPhone (install Apple Devices from Microsoft Store, enable Personal Hotspot) and Android (enable USB tethering in phone settings)." },
    ],
  },
  {
    version: "1.0.481",
    date: "23 May 2026",
    items: [
      { category: "New", text: "Use Hotspot — tick the checkbox on any account and its traffic will automatically route through your phone's mobile data via USB tethering, leaving your main internet connection completely untouched." },
      { category: "New", text: "The Proxy Settings panel now shows a USB adapter picker when Use Hotspot is on — detected adapters are listed with Start/Stop relay buttons so you can confirm which phone connection is active before running." },
      { category: "New", text: "The relay starts automatically when the automation engine runs a hotspot-enabled account, so no manual setup is needed beyond ticking the checkbox and plugging in the phone." },
    ],
  },
  {
    version: "1.0.480",
    date: "23 May 2026",
    items: [
      { category: "Fixed", text: "Apply Proxy to LDPlayer now routes through an ADB reverse tunnel instead of a direct network connection — eliminating the need to detect the gateway IP and removing any dependency on Windows Firewall rules." },
      { category: "Fixed", text: "ADB commands (device list, android ID, proxy set, package check) are no longer blocking — they were freezing the entire app for 5–40 seconds at a time. They now run asynchronously so Instagram automation and all other activity continues normally while ADB is waiting." },
    ],
  },
  {
    version: "1.0.479",
    date: "23 May 2026",
    items: [
      { category: "Fixed", text: "Spoofed Device ID no longer stays on Not set for several minutes after clicking Apply — a silent timeout bug meant the ADB write was silently ignored and the next background poll reverted it. The write now detects the timeout and shows a proper error instead of pretending it succeeded." },
      { category: "Fixed", text: "Spoofed Device ID no longer flickers back to Not set after being set — the page was polling ADB every 5 seconds and overwriting the value. The ID is now cached server-side and the poll is removed; the value stays correct until you change it." },
    ],
  },
  {
    version: "1.0.478",
    date: "23 May 2026",
    items: [
      { category: "Fixed", text: "Proxy assignment to LDPlayer now works correctly for authenticated proxies — a local relay running on the host injects credentials automatically so Android never sees a 407 and traffic routes through the real proxy IP." },
      { category: "Fixed", text: "Keep accounts valid checkbox added to the Proxy Manager — tick it before assigning or splitting proxies to prevent accounts from dropping to pending status." },
    ],
  },
  {
    version: "1.0.477",
    date: "23 May 2026",
    items: [
      { category: "Fixed", text: "Fix ABD now tries banner_dismiss with the stored session first, then falls back to a fresh mobile login using the stored password and device fingerprint — no embedded browser required at any point." },
      { category: "Fixed", text: "Clicking between Accounts and Dashboard no longer causes the app to lag or hang — queries no longer all fire at once when the window receives focus." },
      { category: "Fixed", text: "Group collapsed/expanded state on the Accounts page is now remembered across restarts." },
      { category: "Fixed", text: "Apply Proxy to LDPlayer now uses the correct format — the previous release accidentally broke the proxy setting by including username and password in the wrong place." },
    ],
  },
  {
    version: "1.0.476",
    date: "23 May 2026",
    items: [
      { category: "Fixed", text: "Fix ABD now calls the Instagram dismiss endpoint directly using the stored account credentials — no browser, no challenge flow, no re-probing. If Instagram accepts the dismiss the account is immediately restored to valid." },
    ],
  },
  {
    version: "1.0.475",
    date: "23 May 2026",
    items: [
      { category: "Fixed", text: "Fix ABD now works on accounts with a hard session block (logout reason 8) — it performs a fresh login, catches the automated behaviour checkpoint, and dismisses it automatically using the stored password." },
      { category: "Fixed", text: "Spoof ID in Create & Spoof no longer stays stuck on Reading — it now shows Not Set when no ID is stored and only shows Reading while it is actually loading." },
      { category: "Fixed", text: "Apply Proxy to LDPlayer now sends the username and password along with the host and port, and broadcasts the change so Instagram picks it up immediately without needing a restart." },
    ],
  },
  {
    version: "1.0.471",
    date: "23 May 2026",
    items: [
      { category: "Fixed", text: "Accounts with an Automated Behaviour Detected prompt now correctly return that status on Verify, even when Instagram signals it via 403 blocks rather than the usual challenge response." },
    ],
  },
  {
    version: "1.0.472",
    date: "23 May 2026",
    items: [
      { category: "Fixed", text: "Clicking a device in Create & Spoof no longer causes a white screen crash." },
      { category: "Fixed", text: "Open EB and Login EB are now on separate rows in the Actions menu instead of squashed side by side." },
      { category: "Fixed", text: "Keyboard shortcut labels in the Actions menu are now black and sit inline next to each item instead of faint grey aligned to the far right." },
      { category: "Improved", text: "Fix Auto-Behaviour now tries additional dismiss endpoints including the one the native Instagram app uses when the user taps Dismiss on the automated behavior interstitial." },
    ],
  },
  {
    version: "1.0.470",
    date: "23 May 2026",
    items: [
      { category: "Fixed", text: "Accounts with Automated Behaviour Detected now correctly show that status after clicking Verify instead of incorrectly showing Logged Out." },
    ],
  },
  {
    version: "1.0.469",
    date: "22 May 2026",
    items: [
      { category: "Fixed", text: "Removed the proxy relay server from Create & Spoof — it was binding to all network adapters and causing home internet connection drops." },
      { category: "Removed", text: "CloakBrowser tab has been removed." },
      { category: "Changed", text: "Create & Spoof now uses LD Player instead of BlueStacks — setup guide, address hints, and all references updated." },
    ],
  },
  {
    version: "1.0.466",
    date: "22 May 2026",
    items: [
      { category: "New", text: "CloakBrowser tab added — launches a stealth Chromium browser for account creation testing, routed through any proxy from your Proxy Manager." },
      { category: "New", text: "CloakBrowser includes a live interactive browser panel with back, forward, reload, and a URL bar." },
    ],
  },
  {
    version: "1.0.465",
    date: "22 May 2026",
    items: [
      { category: "Fixed", text: "Embedded browser (EB) now opens maximised by default — the window no longer appears as a small 1280×820 box that you have to manually expand." },
      { category: "Fixed", text: "Toolbar buttons in the EB are now larger and easier to click (Back, Forward, Reload, Home, New Tab, Login, 2FA, Phone, Email)." },
      { category: "Fixed", text: "2FA button now actively finds the code input on screen, clears it, fills the code, and clicks the Continue button — it no longer relies on which field was last clicked." },
      { category: "Fixed", text: "Cookie consent banner is now dismissed automatically every 8 seconds while the EB is open — covers cases where the banner appears after initial navigation." },
    ],
  },
  {
    version: "1.0.464",
    date: "22 May 2026",
    items: [
      { category: "New", text: "Deep Reset button added to the Create & Spoof device card — clears Instagram, Google account data, and advertising IDs in one step to help avoid ban-on-creation." },
      { category: "New", text: "GAID (Advertising ID) reset added to the Reset flow — resets the Google Advertising ID before each account creation attempt." },
      { category: "New", text: "Source network adapter picker added — lets you bind the proxy relay to a specific network interface (e.g. a USB tether) so only BlueStacks traffic is routed through it." },
    ],
  },
  {
    version: "1.0.463",
    date: "22 May 2026",
    items: [
      { category: "Fixed", text: "Reset no longer uninstalls Instagram — it just clears the app data, so Instagram stays installed and you skip the 10-minute re-download for every account." },
      { category: "New", text: "APK cache added — after your first Play Store install, the APK is saved locally so future installs take ~5 seconds instead of 10 minutes." },
      { category: "New", text: "Install screen now shows a blue 'Install Instagram (~5s, cached)' button when the local cache is ready, with an option to re-download from Play Store if needed." },
    ],
  },
  {
    version: "1.0.462",
    date: "22 May 2026",
    items: [
      { category: "Fixed", text: "Apply proxy now works on BlueStacks — the emulator's network gateway is detected automatically (falls back to the standard Android host address 10.0.2.2) so the proxy applies every time." },
    ],
  },
  {
    version: "1.0.461",
    date: "22 May 2026",
    items: [
      { category: "Fixed", text: "Drony removed entirely — proxy now applies instantly via a built-in local relay with no VPN, no disconnections, and no third-party app required." },
      { category: "Fixed", text: "Wrong IP issue resolved — the relay correctly authenticates to your proxy and routes all traffic through it." },
      { category: "Fixed", text: "Reset no longer closes BlueStacks — BlueStacks stays open so you can change the device profile yourself without the 5-minute freeze." },
      { category: "New", text: "Protocol selector added (HTTP / SOCKS5) — pick the type that matches your proxy provider." },
    ],
  },
  {
    version: "1.0.460",
    date: "22 May 2026",
    items: [
      { category: "Fixed", text: "Drony now opens automatically in BlueStacks when Apply proxy via Drony is clicked — uses a more reliable launch method so it always appears on screen." },
      { category: "New", text: "Proxy type selector added (SOCKS5 / SOCKS4 / HTTP / HTTPS) — choose the correct type for your proxy before applying so Drony routes traffic properly." },
      { category: "New", text: "Reconnecting banner now shows while BlueStacks is recovering its ADB connection after Drony's VPN activates — no more jumping back to the empty screen." },
    ],
  },
  {
    version: "1.0.459",
    date: "22 May 2026",
    items: [
      { category: "Fixed", text: "BlueStacks now reliably comes to the front when Apply proxy via Drony is clicked — improved the window focus command so it works consistently." },
      { category: "New", text: "Device panel now opens automatically after Drony proxy is successfully applied — no need to click the device card manually." },
      { category: "New", text: "Open Instagram & Sign Up button added — opens Instagram in BlueStacks, taps Get Started, selects email signup, and pre-fills the email from your credentials form automatically." },
      { category: "Improved", text: "Reset for next account now does a full cleanup: deactivates Drony, disconnects the device from Equinox, and closes BlueStacks — ready to start fresh with the next account." },
    ],
  },
  {
    version: "1.0.458",
    date: "22 May 2026",
    items: [
      { category: "New", text: "Install Instagram via Google Play button added — one click opens Play Store inside BlueStacks and taps Install automatically. No APK download needed." },
      { category: "Improved", text: "APK install is still available as a fallback option below the Play Store button." },
    ],
  },
  {
    version: "1.0.457",
    date: "22 May 2026",
    items: [
      { category: "Improved", text: "BlueStacks now comes to the front automatically when Apply proxy via Drony is clicked — you can watch the automation happen in real time." },
      { category: "Fixed", text: "After Drony's VPN activates, Equinox now immediately reconnects ADB — device reconnects in seconds instead of waiting up to 2 minutes for BlueStacks to auto-recover." },
      { category: "Improved", text: "A note is shown while the automation runs explaining that a brief disconnection is normal and will self-recover." },
    ],
  },
  {
    version: "1.0.456",
    date: "22 May 2026",
    items: [
      { category: "Improved", text: "Drony automation is now fully automatic — clicking Apply proxy via Drony opens Drony, fills in the proxy details, saves the config, and activates the VPN all in one go with no manual steps needed." },
      { category: "Fixed", text: "Drony's + button is now found reliably using multiple detection methods including resource ID and screen position — the proxy form always opens correctly." },
      { category: "Fixed", text: "Proxy host, port, username, and password fields are now filled correctly using a robust field-finding approach that works across all Drony versions." },
      { category: "Fixed", text: "Drony's VPN power button is now activated automatically, with a coordinate fallback if the button cannot be identified by text." },
    ],
  },
  {
    version: "1.0.455",
    date: "22 May 2026",
    items: [
      { category: "Fixed", text: "Drony automation no longer fails with 'Drony did not open' when the app name shows as Droni inside BlueStacks — the check now uses the package name which is always correct." },
      { category: "Fixed", text: "Drony launch now waits longer and retries the screen read once if BlueStacks is still animating — prevents false failures on slower PCs." },
      { category: "Fixed", text: "Duplicate device cards no longer appear when BlueStacks registers itself as both a TCP connection and an emulator connection at the same time." },
      { category: "Improved", text: "Setup guide now shows only BlueStacks — LDPlayer references removed throughout." },
    ],
  },
  {
    version: "1.0.454",
    date: "22 May 2026",
    items: [
      { category: "New", text: "Drony VPN proxy automation added to Create & Spoof — install Drony once, then clicking Apply Proxy via Drony makes Equinox open Drony in BlueStacks, fill in the proxy host, port, and credentials automatically, and activate the VPN. All BlueStacks traffic including Instagram HTTPS is routed through the proxy without any manual steps." },
      { category: "New", text: "Add another emulator button now opens a connection form inline — you can auto-detect or type an address to connect a second BlueStacks or LDPlayer instance without leaving the page." },
      { category: "New", text: "BlueStacks device profile panel added inside every device card — shows manufacturer, model, Android version, and resolution read live from the device. A Refresh button re-reads the values after you change the profile in BlueStacks Settings." },
      { category: "Improved", text: "Proxy selector simplified — the global Android proxy and relay buttons have been replaced by the Drony VPN approach which actually works for Instagram HTTPS traffic." },
    ],
  },
  {
    version: "1.0.453",
    date: "22 May 2026",
    items: [
      { category: "Fixed", text: "Verify now correctly detects when Instagram flags an account as needing a security challenge — those accounts now show the Captcha status instead of being incorrectly marked as Valid." },
      { category: "Fixed", text: "Automated Behaviour Detected is now correctly identified during verification and sets the account to the ABD status." },
      { category: "New", text: "Reset for next account button added to the Create & Spoof device panel. One click uninstalls Instagram, generates a fresh device ID, and clears the proxy — the device is ready for the next signup." },
      { category: "New", text: "Device fingerprint is now captured and saved when you save an account from Create & Spoof — the device hardware profile and User Agent are stored so Equinox can identify as that exact device during verification." },
      { category: "New", text: "Copy buttons added to every credential field on Create & Spoof — click to copy Username, Password, Email, or Date of Birth directly to your clipboard for easy pasting into BlueStacks." },
      { category: "New", text: "Device Proxy button added to the Create & Spoof proxy selector — it reads back the actual proxy configured on the device via ADB so you can confirm BlueStacks is routing through the right proxy." },
      { category: "Improved", text: "The Disconnect button on device cards now shows a spinner while disconnecting and is disabled until complete." },
    ],
  },
  {
    version: "1.0.474",
    date: "23 May 2026",
    items: [
      { category: "Fixed", text: "Apply IP to LD Player button is back in the Create & Spoof proxy section — clicking it pushes the selected proxy to the Android device via ADB so LD Player routes through it immediately." },
      { category: "Fixed", text: "Automated Behaviour Detected auto-dismiss now calls the correct Instagram endpoint — the same one Jarvee uses — so the ABD warning is cleared and the account is restored to valid without any manual steps." },
    ],
  },
  {
    version: "1.0.452",
    date: "22 May 2026",
    items: [
      { category: "Fixed", text: "Fix Auto-Behaviour now works without having to select accounts first — a Fix button appears directly in the ABD column on every account row." },
      { category: "Improved", text: "The Fix Auto-Behaviour option in the Actions menu now runs on all visible accounts when nothing is selected, matching the same behaviour as Verify." },
    ],
  },
  {
    version: "1.0.451",
    date: "22 May 2026",
    items: [
      { category: "New", text: "Settings page now has a Start with Windows toggle. When enabled, Equinox launches automatically when Windows starts, minimised to the tray." },
      { category: "Improved", text: "The Create an Account tab has been removed from the sidebar — account creation is handled through the Create & Spoof page." },
      { category: "Improved", text: "Bulk Import renamed to Bulk Import Accounts, and Mobile renamed to Create & Spoof in the sidebar." },
    ],
  },
  {
    version: "1.0.450",
    date: "22 May 2026",
    items: [
      { category: "New", text: "Fix Auto-Behaviour button added to the account actions menu. Use it to manually trigger an ABD dismissal for any account at any time, without waiting for automation to encounter one." },
    ],
  },
  {
    version: "1.0.449",
    date: "22 May 2026",
    items: [
      { category: "Fix", text: "On the Mobile page, the Install Instagram from APK section is now hidden when Instagram is already detected as installed. A compact green badge replaces it, with a Reinstall link if you ever need to overwrite it." },
      { category: "Improved", text: "Selecting a proxy on the Mobile page now applies it to the device immediately — no separate Apply button click required." },
      { category: "New", text: "Test IP button added to each device on the Mobile page. When a proxy is assigned, clicking Test IP makes a live check through that proxy and shows the external IP address it is routing through, so you can confirm it is working before starting a session." },
    ],
  },
  {
    version: "1.0.448",
    date: "21 May 2026",
    items: [
      { category: "New", text: "The proxy selector on the Mobile page now actually routes BlueStacks traffic through your chosen proxy. Equinox starts a silent local relay in the background — no manual configuration needed. Just pick a proxy and click Apply." },
    ],
  },
  {
    version: "1.0.447",
    date: "21 May 2026",
    items: [
      { category: "New", text: "Mobile page now auto-detects scrcpy on your Desktop and Downloads folders — no PATH configuration needed." },
      { category: "New", text: "Random generators added to the credential form on the Mobile page. Each field (username, password, email, date of birth) gets its own shuffle button. A Generate All button fills everything at once." },
      { category: "New", text: "Custom spintax editor added to the Mobile credential form. Paste your own spintax like {maia|nina|zara}_{1..99} for any field and it will be used instead of the built-in generator. Settings save automatically." },
      { category: "Fix", text: "Clicking Launch in the Mobile panel no longer closes an open scrcpy mirror window. The launch command has been changed to avoid triggering ADB server restarts." },
    ],
  },
  {
    version: "1.0.446",
    date: "21 May 2026",
    items: [
      { category: "New", text: "When Instagram fires an Automated Behaviour Detected warning during automation, the app now briefly shows a new account status — Auto Behav. — while it automatically dismisses the warning via the Instagram API. If the dismissal succeeds, automation continues without applying a suspension. Each successful dismissal is counted and shown in a new ABD column on the accounts page." },
      { category: "New", text: "New ABD column on the accounts page shows how many Automated Behaviour warnings have been auto-dismissed for each account today. The column label in the settings dialog is Automatic Behaviour Detected." },
    ],
  },
  {
    version: "1.0.445",
    date: "21 May 2026",
    items: [
      { category: "Fix", text: "After 2FA, Instagram's redirect chain can exceed Chrome's redirect limit and produce a blank error page. The app now detects this automatically and navigates directly to instagram.com — bypassing the broken redirect — so you land on the home feed instead of a white screen. Up to 3 auto-recovery attempts are made before giving up." },
      { category: "Fix", text: "Chrome load errors on Instagram pages (ERR_TOO_MANY_REDIRECTS, proxy tunnel failures, etc.) are now logged with their exact error code so problems can be identified." },
    ],
  },
  {
    version: "1.0.444",
    date: "21 May 2026",
    items: [
      { category: "Fix", text: "Embedded browser toolbar now has a guaranteed recovery mechanism running entirely outside the browser page. Every 4 seconds the app checks whether the toolbar is present and re-adds it if not — this runs in the background independently of any page events, so even if Instagram's post-2FA navigation sequence prevents the normal injection from working, the toolbar will always reappear within 4 seconds." },
    ],
  },
  {
    version: "1.0.443",
    date: "21 May 2026",
    items: [
      { category: "Fix", text: "Toolbar buttons permanently disappearing after 2FA submission is now fixed. Instagram navigates through several pages quickly after 2FA and the previous toolbar injection was racing with those redirects and silently failing. The toolbar is now injected at three independent points (DOM-ready, navigation commit, and page load complete) with an automatic retry, so at least one always succeeds." },
      { category: "Fix", text: "Toolbar buttons no longer vanish if Instagram's own page scripts remove the toolbar element — a background check now re-adds it within 3 seconds if it goes missing on any page." },
      { category: "Fix", text: "Toolbar was previously being attached to the wrong part of the page (the HTML root element instead of the body) when the page body wasn't ready yet, causing it to render incorrectly. It now waits properly for the body to exist before attaching." },
    ],
  },
  {
    version: "1.0.442",
    date: "21 May 2026",
    items: [
      { category: "New", text: "Embedded browser now auto-accepts the Instagram cookies consent dialog, automatically fills in your username and password, clicks login, and if 2FA is required it fills in the code and submits — all without you having to touch anything." },
      { category: "Fix", text: "After entering a 2FA code in the embedded browser the page went white and all toolbar buttons disappeared. The toolbar is now injected earlier in the page lifecycle (at DOM-ready, not just full load) so it reappears immediately after each navigation." },
      { category: "Fix", text: "New browser tab windows (opened via the toolbar) now get the toolbar injected at DOM-ready as well as on full load, matching the behaviour of the main embedded browser window." },
    ],
  },
  {
    version: "1.0.441",
    date: "21 May 2026",
    items: [
      { category: "Fix", text: "Verify now correctly detects an existing login on the Windows app and skips the re-login step. Previously the Windows verify flow always attempted a fresh login even when the account was already logged in via the embedded browser, causing a 'Could not find login form' error." },
      { category: "Fix", text: "Embedded browser toolbar buttons now always appear, even when the page is still loading or hasn't fully rendered. The toolbar injection previously failed silently if the page body wasn't ready yet." },
    ],
  },
  {
    version: "1.0.440",
    date: "21 May 2026",
    items: [
      { category: "Fix", text: "Verify no longer times out and goes back to pending on slow proxies. The initial app config download was taking 90+ seconds on some proxies, leaving no time for the actual session check. It is now capped at 20 seconds and skipped if slow so the session check always gets a chance to run." },
      { category: "Fix", text: "Embedded browser toolbar buttons no longer go missing on Windows. If the browser window had previously failed to load a page (e.g. due to a proxy issue), the toolbar was silently lost and never recovered. The toolbar is now re-injected whenever the window is re-opened, and the page is automatically navigated back to Instagram if it was stuck on an error screen." },
    ],
  },
  {
    version: "1.0.439",
    date: "21 May 2026",
    items: [
      { category: "Fix", text: "The app process now exits immediately and completely when closing. Previously the process could linger in the background after the tray icon disappeared, causing the updater to report the software was still running." },
    ],
  },
  {
    version: "1.0.438",
    date: "21 May 2026",
    items: [
      { category: "Fix", text: "Verify no longer tries to re-login if you are already logged in via the embedded browser — it reads the existing session cookies directly and skips the re-login step that was wiping your session and failing." },
      { category: "Fix", text: "The Phone, Email, and Email Pass toolbar buttons now correctly paste into the field you last clicked on. Previously clicking the button shifted focus away from the field so nothing was pasted." },
      { category: "Fix", text: "Removed the duplicate account username label that was appearing to the left of the Back button in the embedded browser toolbar." },
    ],
  },
  {
    version: "1.0.437",
    date: "21 May 2026",
    items: [
      { category: "Fix", text: "The Login button now finds the username and password fields directly on the current page and fills them in — it no longer navigates away from the page you are on. If the login form is not visible yet, it opens the login page first." },
      { category: "Fix", text: "The 2FA, Phone, Email, and Email Pass buttons now correctly paste into whichever field you have clicked on." },
      { category: "Remove", text: "The Clear button has been removed from the browser toolbar." },
      { category: "New", text: "A New Tab button (+) opens a second browser window for the same account, sharing the same session and cookies." },
      { category: "Fix", text: "Right-clicking inside the browser now shows a Cut / Copy / Paste / Select All context menu." },
      { category: "Fix", text: "The browser window title and toolbar now show the account username (e.g. 🤖 myaccount) instead of the word Instagram." },
    ],
  },
  {
    version: "1.0.436",
    date: "21 May 2026",
    items: [
      { category: "Fix", text: "Pressing Verify no longer opens a visible browser window. The login and cookie harvest now happen silently in the background — you will never see a browser pop up when verifying an account." },
      { category: "Fix", text: "The Verify flow now correctly captures session cookies and passes them to the mobile API, so accounts should actually reach Valid status after a successful login." },
      { category: "Fix", text: "The system tray icon now disappears immediately when closing the app. Previously the ghost icon remained in the taskbar and gave an error on right-click." },
    ],
  },
  {
    version: "1.0.435",
    date: "21 May 2026",
    items: [
      { category: "Fix", text: "After pressing Verify, clicking Browser for that account now correctly shows the embedded browser window — it was being hidden and not re-shown on subsequent opens." },
      { category: "Fix", text: "The embedded browser toolbar is now white with a light theme instead of dark blue." },
      { category: "New", text: "The embedded browser toolbar now shows a live timer (e.g. 2:34) counting how long the browser has been open. The timer persists across page navigations within the same session." },
    ],
  },
  {
    version: "1.0.434",
    date: "21 May 2026",
    items: [
      { category: "New", text: "The embedded browser window now has a built-in toolbar: Back, Forward, Reload, Home, URL bar, Login, 2FA Code, Phone Number, Email Account, Email Password, and Clear — all living directly on the native browser window." },
      { category: "Fix", text: "Browser controls removed from the Human Sessions tab — they had no relevance there and belong on the EB window itself." },
      { category: "Fix", text: "Clicking Verify more than once for the same account now correctly reopens the embedded browser window — previously it would silently skip re-opening after the first verify." },
    ],
  },
  {
    version: "1.0.433",
    date: "21 May 2026",
    items: [
      { category: "Fix", text: "Opening an embedded browser no longer spawns sub-windows — any popup or new-tab request Instagram fires is now redirected into the same single EB window." },
      { category: "Fix", text: "Closing an embedded browser window with the X button now hides it to the system tray instead of destroying the session." },
      { category: "Fix", text: "Browser controls (toolbar) removed from the Human Sessions tab — the browser opens correctly as its own standalone window via the Browser button." },
      { category: "Fix", text: "Bring to Front now correctly focuses the existing EB window for an account instead of silently doing nothing." },
    ],
  },
  {
    version: "1.0.432",
    date: "21 May 2026",
    items: [
      { category: "Fix", text: "Included all missing files from v1.0.431 — Electron browser window manager, main process, preload bridge, browser session handler, and sidebar were absent from the previous build." },
    ],
  },
  {
    version: "1.0.431",
    date: "21 May 2026",
    items: [
      { category: "New", text: "Mobile tab completely rebuilt — connect BlueStacks, LDPlayer, Nox, or any Android emulator in two clicks, no Android Studio required." },
      { category: "New", text: "Auto-detect button scans all known emulator ports and connects whatever is running." },
      { category: "New", text: "Each connected device gets its own spoofed Device ID (android_id) — editable, copyable, and randomisable per device." },
      { category: "New", text: "Per-device proxy assignment pulls from your existing Proxy Manager list and can be applied to a running emulator instantly." },
      { category: "New", text: "Device panel: install Instagram from APK, launch, clear app data, mirror screen, and save account credentials — all from Equinox." },
      { category: "Fix", text: "Embedded browser windows no longer open multiple times when clicking Browser repeatedly." },
      { category: "Fix", text: "Minimising the embedded browser no longer opens a new window — it brings the existing one back." },
      { category: "Fix", text: "Browser control panel (URL bar, login, 2FA, clear session) is now embedded directly in the Human Session tab." },
    ],
  },
  {
    version: "1.0.430",
    date: "21 May 2026",
    items: [
      { category: "Fix", text: "Clicking Browser now shows the full control panel in the main app — URL bar, back, forward, refresh, home, login, 2FA code, phone number, email account, email password, upload, and clear session are all back." },
      { category: "Fix", text: "The native browser window still opens as before, and the Bring to Front button in the toolbar instantly focuses it." },
      { category: "Improvement", text: "The address bar in the control panel now updates automatically as you navigate in the native browser window." },
      { category: "Improvement", text: "Toolbar buttons that type text (2FA code, phone number, email) now inject directly into the focused field in the native browser window." },
    ],
  },
  {
    version: "1.0.429",
    date: "21 May 2026",
    items: [
      { category: "Improvement", text: "The embedded browser now opens as a real native window instead of a streamed canvas. Each account gets its own dedicated browser window you can interact with directly — no lag, no frozen frames, no compression." },
      { category: "Improvement", text: "Cookies are automatically captured and saved to the account after every Instagram page load in the native window. The Verify flow works exactly as before." },
      { category: "Improvement", text: "The Browser panel now shows a 'Bring to Front' button to instantly focus the native window for that account instead of a video canvas." },
    ],
  },
  {
    version: "1.0.428",
    date: "21 May 2026",
    items: [
      { category: "Fix", text: "Removed all image, font, and media blocking from the embedded browser. These restrictions were causing pages to hang on a white screen. The browser now loads pages without any interference." },
    ],
  },
  {
    version: "1.0.427",
    date: "21 May 2026",
    items: [
      { category: "Fix", text: "Reduced CPU and memory load when multiple accounts are stuck in an Instagram security challenge at the same time. Chrome no longer streams video frames when nobody is actively watching that browser window. Challenge checks are now staggered so several accounts don't all fire at the exact same moment." },
      { category: "Fix", text: "Database writes from browser traffic are now deferred to the background so they can't block other work happening in the app at the same time." },
      { category: "Fix", text: "Added an event-loop lag detector — the app now logs a warning whenever something caused a delay of more than 100 ms, making future slowdowns much easier to diagnose." },
    ],
  },
  {
    version: "1.0.426",
    date: "21 May 2026",
    items: [
      { category: "Fix", text: "Fixed the CPU spike — accounts with an Instagram security challenge (update_risky_contactpoint) were hammering Chrome with ~3 navigation requests per second each in an infinite redirect loop. The challenge check now waits 30 seconds between attempts instead of retrying immediately. CPU impact from challenge accounts drops from continuous to near-zero." },
    ],
  },
  {
    version: "1.0.425",
    date: "20 May 2026",
    items: [
      { category: "Fix", text: "Added CPU spike diagnostics — the app now logs every network request type and Chrome performance metrics (JS time, heap size, layout count) every 30 seconds for the first 5 minutes after each EB opens. This will identify the exact cause of the spike." },
    ],
  },
  {
    version: "1.0.424",
    date: "20 May 2026",
    items: [
      { category: "Fix", text: "Removed the background-tab throttle (Page lifecycle hidden/active) introduced in v1.0.421 — it was causing EBs to freeze and stop responding to user input. All EBs now stay in full-speed mode at all times." },
    ],
  },
  {
    version: "1.0.423",
    date: "20 May 2026",
    items: [
      { category: "Fix", text: "Fixed the 2-minute CPU spike — Instagram auto-loads Reel videos shortly after the feed renders; with software rendering Chrome decodes video on the CPU causing a heavy spike. Video files are now blocked at the network level (videos are never needed to manage a session) and Chrome is told not to auto-play media without a click." },
      { category: "Fix", text: "Blocked Instagram's analytics beacons and tracking pixels that fire at ~2 minutes — their large response payloads triggered JavaScript processing that contributed to the spike." },
      { category: "Fix", text: "Font files are now always blocked (not just when the browser panel is closed) — fonts are unnecessary for session management and loading them wastes bandwidth and memory." },
    ],
  },
  {
    version: "1.0.422",
    date: "20 May 2026",
    items: [
      { category: "Fix", text: "Fixed CPU spiking at exactly 2 minutes after opening an Antidetect browser — Chrome's memory limit was set too low (128 MB), causing a large garbage collection sweep when Instagram's page data filled the heap. Raised to 256 MB to give the page enough room." },
      { category: "Fix", text: "Fixed a secondary CPU spike loop introduced in v1.0.421 — the crash detector was incorrectly treating expected frame silence (when the browser is in low-power mode) as a freeze, restarting the screencast every 5-15 seconds until the 2-minute mark." },
    ],
  },
  {
    version: "1.0.421",
    date: "20 May 2026",
    items: [
      { category: "Fix", text: "Fixed CPU spiking when Antidetect browsers are open — Chrome now enters a low-power mode 3 seconds after the user stops interacting, throttling Instagram's background animations and timers to near-zero. Touching the browser restores full speed instantly." },
      { category: "Fix", text: "Reduced how often Chrome encodes and sends video frames when idle — the browser now sends fewer than 1 frame per second when idle and less than 1 every 5 seconds when dormant, instead of the previous 2fps and 0.5fps." },
    ],
  },
  {
    version: "1.0.420",
    date: "20 May 2026",
    items: [
      { category: "Fix", text: "Clear Cookies now actually clears the session — Chrome's internal cookie store, localStorage, and IndexedDB are wiped via an in-process command before Chrome closes, so the account is genuinely logged out even on Windows where file deletion is delayed by OS file locks." },
      { category: "Fix", text: "File deletion after Clear Cookies now retries for up to 6 seconds (was 1.5 s) to give Windows time to release Chrome's file handles." },
    ],
  },
  {
    version: "1.0.419",
    date: "20 May 2026",
    items: [
      { category: "Fix", text: "Fixed CPU spiking when Antidetect browsers are open — GPU compositing was generating up to 60 frames per second on idle pages; reverting to software rendering means Chrome only generates a frame when the page actually changes, keeping idle CPU near-zero." },
      { category: "Fix", text: "Opening multiple Antidetect browsers at once no longer saturates the CPU — launches are now staggered (max 3 at a time instead of 10)." },
      { category: "Fix", text: "If an Antidetect browser failed to open due to a proxy error, trying to open it again no longer hangs for 20 seconds before retrying." },
    ],
  },
  {
    version: "1.0.418",
    date: "20 May 2026",
    items: [
      { category: "Fix", text: "Clear Cookies now does a complete wipe — nothing is left behind. Previously it kept device tokens in the database and wrote them back to a seed file; now the account returns to a blank pending state, ready for a fresh login." },
      { category: "Fix", text: "If a proxy error causes the embedded browser to lose its cookie file, the app now recovers automatically from the database on next open instead of landing on the login page." },
      { category: "Fix", text: "The 60-second cookie save can no longer overwrite a valid session file with an empty one when a session expires mid-use." },
    ],
  },
  {
    version: "1.0.417",
    date: "20 May 2026",
    items: [
      { category: "Fix", text: "Opening an Antidetect browser no longer pegs CPU at 100% — Chrome now uses your GPU for rendering on Windows instead of doing all the work on the CPU." },
    ],
  },
  {
    version: "1.0.416",
    date: "20 May 2026",
    items: [
      { category: "Fix", text: "Opening an Antidetect browser no longer pegs CPU at 100% while idle — the browser now drops from ~10 frames per second down to ~0.5 fps when you haven't touched it for 30 seconds, and snaps back to full speed the moment you click or type." },
    ],
  },
  {
    version: "1.0.415",
    date: "20 May 2026",
    items: [
      { category: "Fix", text: "Clicking on the Antidetect browser canvas now lands exactly where you click — previously every click was shifted up/down by 30–50 pixels due to the letterbox gap above the page stream, making it impossible to hit the Instagram login fields." },
      { category: "Fix", text: "Typing in the Antidetect browser now works reliably — after a click, the focused input field is explicitly activated so your keystrokes actually appear in the field." },
    ],
  },
  {
    version: "1.0.414",
    date: "19 May 2026",
    items: [
      { category: "Fix", text: "The 'We suspect automated behavior' security challenge now attempts to load directly in the embedded browser by following each redirect hop as a separate navigation — bypassing Chrome's built-in 20-redirect limit that previously caused a dead error screen." },
      { category: "Fix", text: "If the challenge page cannot be loaded (account is heavily flagged and Instagram serves an infinite redirect chain), a clear message now appears within 15 seconds telling you to open Instagram on your phone and tap Dismiss or Approve — then the browser updates automatically." },
    ],
  },
  {
    version: "1.0.413",
    date: "19 May 2026",
    items: [
      { category: "Fix", text: "The embedded browser screen is now always full resolution regardless of how many accounts are open — previously the image was downscaled to as low as 720×430 with 3 or more browsers open, making everything look blurry." },
      { category: "Fix", text: "Embedded browsers that stop updating while you are actively using them now recover automatically within 20 seconds instead of staying frozen until you manually reload." },
      { category: "Fix", text: "Instagram's 'Automatic Behaviour Detected' challenge page now loads correctly in the embedded browser instead of showing a redirect error — the fix syncs all session cookies accumulated during redirect resolution back to Chrome before it navigates." },
      { category: "Fix", text: "All bottom-right popup notifications have been removed from the app." },
    ],
  },
  {
    version: "1.0.408",
    date: "19 May 2026",
    items: [
      { category: "Fix", text: "Opening the embedded browser no longer launches Chrome 3 times simultaneously when the connection bounces — only the first caller now starts Chrome, others wait for it to be ready." },
      { category: "Fix", text: "The 'Try another way' verification page now loads reliably in the embedded browser — the previous approach conflicted with Chrome's internal redirect limit. It now piggybacks on the existing request handler instead of adding a second listener." },
      { category: "Fix", text: "Disabling verification-page tracking no longer accidentally turns off background image blocking for the rest of the session." },
      { category: "Fix", text: "The 'Starting browser…' overlay now always clears — previously it could get stuck if the WebSocket connection wasn't fully open at the exact moment Chrome confirmed the stream started." },
    ],
  },
  {
    version: "1.0.407",
    date: "19 May 2026",
    items: [
      { category: "Fix", text: "Clear Cookies now reliably wipes saved login info — Chrome was holding file locks on Windows and the deletion was silently failing. The app now waits for Chrome to fully exit and retries up to 3 times before giving up." },
      { category: "Fix", text: "Reset Device IDs has the same retry fix — same Windows file-lock race that prevented the userdata directory from being fully deleted." },
      { category: "Fix", text: "The 'Check your notifications on another device' login challenge (device approval) is now detected and handled — previously the EB would land on an error page with no recovery. It now attempts to resolve and display the waiting-for-approval page so you can approve from your phone and continue." },
      { category: "Fix", text: "If the device approval redirect chain isn't caught before Chrome hits its redirect limit, the app now falls back to the failing request URL itself and still attempts to load the challenge page rather than parking permanently on the error page." },
    ],
  },
  {
    version: "1.0.406",
    date: "19 May 2026",
    items: [
      { category: "Fix", text: "New accounts created via Bulk Import, Add Profile, and the profiles list now each get a unique random device profile drawn from the full 1000-entry pool — previously all three paths sent no device info and the server always fell back to the same starting entry." },
      { category: "Fix", text: "Pixel 9 Pro and Pixel 9 Pro XL/Fold device specs corrected — wrong codename, chipset code, and screen resolution were being reported; they now match the real hardware." },
      { category: "Fix", text: "Pixel 8/8a chipset code corrected from Tensor G2 to Tensor G3; Pixel 8 Pro, 7 Pro, and Galaxy S23 Ultra screen resolutions corrected to match real devices." },
      { category: "Fix", text: "Core count logic now correctly gives Pixel 8/8a 9 cores (Tensor G3) and all Pixel 9 series 8 cores (Tensor G4) — previously Pixel 9 Pro was being given 9 cores from the wrong regex." },
      { category: "Fix", text: "The Reset Device IDs endpoint now exists on the server — it was being called by Bulk Import after account creation but silently returning 404 every time." },
    ],
  },
  {
    version: "1.0.412",
    date: "19 May 2026",
    items: [
      { category: "Fix", text: "Verify All now runs all selected accounts simultaneously with no delays — previously accounts were verified one at a time with 5–15 second gaps, so 50 accounts could take up to 12 minutes." },
      { category: "Fix", text: "Removed the verify delay settings entirely — there is no reason to artificially stagger logins since every account uses its own proxy and its own Chrome browser session." },
    ],
  },
  {
    version: "1.0.411",
    date: "19 May 2026",
    items: [
      { category: "Fix", text: "Battery level now drains correctly while accounts are running their automation tools via the API — previously it only drained when the embedded browser was open, which is almost never the case during normal operation." },
      { category: "Fix", text: "Each automation runner (follow, unfollow, DM, contact, human session) now stamps its own start time so the battery drift is tracked independently per account from the moment its tools begin running." },
    ],
  },
  {
    version: "1.0.410",
    date: "19 May 2026",
    items: [
      { category: "Fix", text: "Battery percentage and Mbps columns on the accounts page now show live values for every account — they were stuck showing the same static number forever because the server only computed live values for accounts with an open browser session." },
      { category: "Fix", text: "Connection speed (Mbps) now visibly fluctuates every 5 seconds in the accounts list, matching the behaviour of the real stealth script inside Chrome that re-randomises the value every 25–35 seconds — each account pulses at its own independent rate." },
    ],
  },
  {
    version: "1.0.409",
    date: "19 May 2026",
    items: [
      { category: "Fix", text: "The embedded browser no longer shows 'Browser appears frozen' while waiting for Instagram device approval — the browser now displays a stable 'Waiting for approval' screen that updates automatically once you tap Approve on your phone." },
      { category: "Fix", text: "The device-approval waiting screen no longer thrashes Chrome with rapid navigations every 350ms — it now checks for approval every 5 seconds, keeping the browser calm and responsive." },
      { category: "Fix", text: "Fixed an infinite WebSocket reconnect loop in the embedded browser panel that caused the connection to re-establish every 1–4 seconds instead of staying stable." },
      { category: "Fix", text: "The server now prevents a new browser panel connection from displacing an already-active one, which was the root cause of the reconnect feedback loop." },
    ],
  },
  {
    version: "1.0.405",
    date: "19 May 2026",
    items: [
      { category: "Fix", text: "Battery level now slowly drains or charges during the session (0.08–0.12% per minute) instead of staying frozen — a phone that never moves from 78% for 30 minutes is suspicious." },
      { category: "Fix", text: "Connection speed and RTT now fluctuate naturally every 25–35 seconds (±25% of the base value) to simulate real network variance instead of staying locked at a fixed number." },
      { category: "Fix", text: "Timezone is now spoofed per account — the server was reporting UTC (offset 0) while real phones report their local US or EU timezone. DST is computed correctly from today's date." },
      { category: "Fix", text: "Speech synthesis voices are now present — headless Chrome returns an empty list while real Android Chrome has Google voices, which was a detectable gap." },
    ],
  },
  {
    version: "1.0.404",
    date: "19 May 2026",
    items: [
      { category: "Fix", text: "Battery level, charging state, connection speed, screen size, device pixel ratio, memory, and CPU cores are now unique per account — derived from the account's user agent so they are consistent across sessions but never identical between accounts." },
      { category: "Fix", text: "Screen dimensions and device pixel ratio now pick from a pool of 12 real Android device profiles (Pixel, Samsung, OnePlus, Motorola, Xiaomi, Sony, OPPO) instead of the same 412×915 for every account." },
      { category: "Fix", text: "Battery level ranges from 60–99%, charging state is ~65% plugged in, and connection speed ranges from 2–100 Mbps — all seeded per account for realistic variation." },
    ],
  },
  {
    version: "1.0.403",
    date: "19 May 2026",
    items: [
      { category: "Fix", text: "Added --disable-blink-features=AutomationControlled to Chrome launch flags — without this, detection scripts could identify the browser as automated even with the navigator.webdriver override in place." },
      { category: "Fix", text: "Screen orientation (portrait) and window.orientation are now spoofed for mobile accounts — their absence was a clear indicator the browser was not a real phone." },
      { category: "Fix", text: "navigator.connection (Network Information API) is now present for mobile accounts — every real Android phone has this; headless Chrome does not." },
      { category: "Fix", text: "navigator.getBattery() now returns a valid battery reading instead of throwing — server Chrome has no battery, which was detectable." },
      { category: "Fix", text: "AudioContext fingerprinting is now protected — audio DSP output (AnalyserNode frequency data) has deterministic per-account noise applied, the same way canvas reads are protected." },
      { category: "Fix", text: "navigator.mediaDevices.enumerateDevices() now returns 3 entries (mic, speaker, camera) instead of 0 — real phones always report these even without permission." },
    ],
  },
  {
    version: "1.0.402",
    date: "19 May 2026",
    items: [
      { category: "Fix", text: "The embedded browser now protects against canvas fingerprinting — Instagram's fingerprinting script was detecting the server's software renderer (SwiftShader) instead of a real Android GPU, which triggered the contact point verification challenge on fresh accounts with no cookie history." },
      { category: "Fix", text: "Canvas reads (getImageData, toDataURL, toBlob) now return deterministic per-account noise seeded by the account's user agent — the same account always looks like the same device, but every account has a distinct fingerprint." },
      { category: "Fix", text: "WebGL GPU strings (RENDERER, VENDOR, and debug renderer info) are now spoofed to a plausible Android GPU matching the account's device profile instead of exposing the server's SwiftShader renderer." },
    ],
  },
  {
    version: "1.0.401",
    date: "19 May 2026",
    items: [
      { category: "Fix", text: "Accounts added manually, imported from CSV, or restored from an EQX file are now automatically assigned a unique paired device User-Agent if one is not already present — imported accounts will no longer arrive with a blank User-Agent." },
      { category: "Fix", text: "The assigned User-Agent is deterministic per username, so re-importing the same account always gives it the same device profile rather than a different random one each time." },
    ],
  },
  {
    version: "1.0.400",
    date: "19 May 2026",
    items: [
      { category: "Security", text: "Accounts with no User-Agent assigned are now blocked from verifying or opening the embedded browser — they previously fell through to a shared generic fingerprint that Instagram uses to link accounts together." },
      { category: "Security", text: "Bulk verify now skips any account with no User-Agent configured rather than running it with the shared fallback, preventing an entire batch from being fingerprint-linked." },
    ],
  },
  {
    version: "1.0.399",
    date: "19 May 2026",
    items: [
      { category: "Security", text: "The Copy Settings bulk update endpoint now only accepts the specific settings it is designed to copy — group, API limits, scheduling, and profile sync. Account identity fields like user-agents, device state, proxy, and session cookies can no longer be touched through this route under any circumstances." },
    ],
  },
  {
    version: "1.0.398",
    date: "19 May 2026",
    items: [
      { category: "Fix", text: "Copy Settings dialog now has a Status filter dropdown so you can narrow the target account list by account status before copying." },
      { category: "Fix", text: "Copy Settings dialog now shows how many accounts are currently selected next to the NONE button." },
      { category: "Fix", text: "Copy Settings dialog no longer shows the @username secondary line under each account name — cleaner list." },
    ],
  },
  {
    version: "1.0.397",
    date: "19 May 2026",
    items: [
      { category: "Security", text: "Cookie harvesting for account creation is now blocked if no user-agent is assigned — Chrome will not open with a generic Windows UA that would mismatch the account's device fingerprint on Instagram's first contact." },
      { category: "Security", text: "The cookie baker (sites visited before signup) is also blocked if no user-agent is assigned — all site visits now use the account's own assigned browser UA with no fallback." },
      { category: "Security", text: "6 Instagram API calls (profile lookups, DMs, follows, image uploads, thread lookups) now use the account's assigned mobile user-agent instead of a hardcoded OPPO device string shared across all accounts." },
    ],
  },
  {
    version: "1.0.396",
    date: "19 May 2026",
    items: [
      { category: "Security", text: "All Instagram traffic now requires a proxy — if an account has no proxy assigned, every action (login, verify, account creation, cookie harvest) is blocked before any network connection is made, so your server IP is never exposed to Instagram." },
      { category: "Security", text: "Cookie harvesting for account creation is now blocked at launch if no proxy is set — Chrome will not open without a proxy, preventing your IP from reaching Instagram before the account even exists." },
      { category: "Security", text: "Account creation is blocked immediately if no proxy is configured — the process stops before sending any signup API calls." },
    ],
  },
  {
    version: "1.0.395",
    date: "19 May 2026",
    items: [
      { category: "Fix", text: "Clear Cookies now wipes everything — Chrome's full profile directory (cookies, localStorage, IndexedDB, saved login details) is deleted, then only the device fingerprint tokens are written back so Instagram does not flag the device as new." },
      { category: "Fix", text: "Create Account cookie baker now runs before signup — websites, YouTube, and Google are visited first in weighted visit order, then Instagram cookies are harvested, then the account is registered." },
      { category: "Fix", text: "Instagram's cookie consent banner is now automatically dismissed during the EB cookie harvest step of account creation." },
      { category: "Fix", text: "The 'Check for Updates' error dialog now shows a plain-English message when the update token has expired, instead of a raw GitHub API response with HTTP headers." },
    ],
  },
  {
    version: "1.0.394",
    date: "19 May 2026",
    items: [
      { category: "Fix", text: "Visit Order section in Create Account now always shows exactly three inputs — Website List %, YouTube %, and Google % — regardless of how many websites are in the list. Adding more websites no longer creates extra inputs." },
      { category: "Fix", text: "Account sort order on the Accounts page is now remembered when you switch to another page and come back — the list stays in whatever order you left it." },
      { category: "Fix", text: "Minimize to system tray on window close is correctly enforced — the window hides completely (no taskbar button) and the tray icon is the only way to restore or quit." },
    ],
  },
  {
    version: "1.0.393",
    date: "19 May 2026",
    items: [
      { category: "Fix", text: "Clear Cookies in account settings now fully works — it closes the live embedded browser session, wipes session cookies from Chrome's own internal database, clears the DB record, and deletes the saved cookie file, so the account no longer shows as logged in when you reopen the EB." },
      { category: "Fix", text: "Device tokens (mid, ig_did, ig_nrcb) are preserved during Clear Cookies so Instagram does not fire an unrecognised-device alert on next login." },
    ],
  },
  {
    version: "1.0.392",
    date: "19 May 2026",
    items: [
      { category: "New", text: "Cookie Baker now automatically detects and dismisses cookie consent / privacy banners on any website it visits — covers OneTrust, CookieBot, CookieConsent, and dozens of other frameworks, with a text-based fallback for custom banners." },
      { category: "Improvement", text: "Banner dismissal runs on both the main site visit and every internal link visit, so banners that appear on sub-pages are handled too." },
    ],
  },
  {
    version: "1.0.391",
    date: "19 May 2026",
    items: [
      { category: "Fix", text: "Clear Cookies button in account settings now always shows — previously it was hidden when no session cookie was stored, making it impossible to find." },
    ],
  },
  {
    version: "1.0.390",
    date: "19 May 2026",
    items: [
      { category: "New", text: "Each website in the Website List now has its own % weight in the Visit Order randomiser — you can control how likely each individual URL is to be visited first, rather than treating the whole list as one block." },
      { category: "Improvement", text: "Proxy host and port are now entered as a single 'host:port' field (e.g. 123.45.67.89:8080) in the Account Creator, matching the format used everywhere else in the app." },
      { category: "Improvement", text: "Renamed 'Create Account via API' button to 'Create Account via EB' to better reflect that account creation goes through the embedded browser." },
      { category: "Improvement", text: "Moved the Watch EB button to the tab bar next to Created Accounts so it's easier to reach without scrolling." },
      { category: "Improvement", text: "Added a Clear Cookies button next to Session Cookie in the account details panel for quick cookie removal without opening extra menus." },
      { category: "Improvement", text: "Minimising the window now sends the app to the system tray instead of closing it, so the app keeps running in the background." },
    ],
  },
  {
    version: "1.0.389",
    date: "19 May 2026",
    items: [
      { category: "New", text: "The 'Watch EB' button on the Account Creator now shows a real live browser view — you can see exactly what Chrome is doing during cookie baking and signup, the same as every other embedded browser panel in the app." },
      { category: "New", text: "YouTube and Google toggle cards now have item count (min–max) and delay (min–max seconds) inputs so you can control how many videos or search results are browsed and how long is spent on each." },
      { category: "New", text: "Added a visit-order percentage randomiser — when Website List, YouTube, or Google are all enabled you can set the probability that each source is visited first, giving more realistic and varied browsing patterns." },
      { category: "Improvement", text: "Account Creator color scheme changed from amber/orange to cyan throughout — buttons, borders, icons, and the verification code input all use a consistent cyan accent." },
    ],
  },
  {
    version: "1.0.388",
    date: "19 May 2026",
    items: [
      { category: "New", text: "Account Creator now shows a live step-by-step trace panel as the signup runs — you can see every API call, HTTP status code, and Instagram response in real time instead of waiting until the end." },
      { category: "New", text: "Added an inline 'Add new proxy' form directly on the Account Creator page — enter a proxy host, port, and optional credentials without leaving the page, and it is automatically selected ready for use." },
    ],
  },
  {
    version: "1.0.387",
    date: "19 May 2026",
    items: [
      { category: "Fix", text: "Fixed \"Randomise timing\" in Copy Settings not actually staggering tool start times — accounts were all firing at nearly the same time. Each account now gets a random start time within the tool's configured \"Wait Until Next Session\" window (between the min and max you've set), so sessions spread out naturally instead of piling up." },
    ],
  },
  {
    version: "1.0.386",
    date: "18 May 2026",
    items: [
      { category: "Fix", text: "Fixed account creation failing with \"EB cookie harvest returned no device cookies\" — Chrome was launching with flags that blocked Instagram's background requests (the mechanism it uses to write the mid and ig_did device cookies). The harvest now uses a separate, lighter set of Chrome flags that allow those requests through, waits for Instagram's scripts to fully run after page load, and polls more reliably before giving up." },
    ],
  },
  {
    version: "1.0.385",
    date: "18 May 2026",
    items: [
      { category: "Fix", text: "Fixed the whole app freezing or becoming unresponsive when 3 or more embedded browsers are open at the same time. Frame delivery is now deferred so it cannot block the app's request handling, simultaneous frame bursts are absorbed rather than piled up, and the stream resolution and quality automatically scale down as more browsers are opened to reduce the processing load." },
    ],
  },
  {
    version: "1.0.384",
    date: "18 May 2026",
    items: [
      { category: "Feature", text: "Added a search box to the Target Sources list — type any part of a hashtag or account name to instantly filter the list. The search box appears automatically once you have at least one source added, and an X button clears it." },
      { category: "Feature", text: "The scheduled run timestamp on every tool now shows the date alongside the time (e.g. \"18 May, 14:30:00\") so you can tell at a glance whether the next run is today, tomorrow, or further out." },
    ],
  },
  {
    version: "1.0.382",
    date: "18 May 2026",
    items: [
      { category: "Fix", text: "Fixed a build error that prevented the app from packaging — an unescaped quote in the update error message was causing the bundler to fail on Windows." },
    ],
  },
  {
    version: "1.0.381",
    date: "18 May 2026",
    items: [
      { category: "Fix", text: "Fixed the real cause of the whole-app freeze when 4+ browser panels are open. The renderer was spending all its time parsing large JSON text frames and decoding base64 JPEGs on the main thread, causing garbage-collection pauses that blocked all UI interaction. Browser panels now stream raw JPEG binary frames — decoded off the main thread — so the rest of the app stays fully responsive no matter how many panels are open." },
    ],
  },
  {
    version: "1.0.380",
    date: "18 May 2026",
    items: [
      { category: "Fix", text: "Having 4 or more browser panels open no longer freezes the entire app (profiles not loading, dashboard not loading, tools stopping). The root cause was Chrome generating frames at full compositor speed for every open panel — the fix now delays the frame acknowledgement so Chrome itself slows down, cutting the event flood that was blocking the server from responding to anything." },
    ],
  },
  {
    version: "1.0.379",
    date: "18 May 2026",
    items: [
      { category: "Fix", text: "Opening 4 or more embedded browsers no longer freezes the entire app — each browser panel now streams frames at a rate that scales with how many are open, so clicking and all other controls stay responsive regardless of how many accounts have their browser running." },
    ],
  },
  {
    version: "1.0.378",
    date: "18 May 2026",
    items: [
      { category: "Fix", text: "Importing an EQX file now always restores the correct account status — previously a database quirk could silently ignore the exported status and fall back to pending even after the fix in 1.0.370." },
      { category: "Fix", text: "Verifying more than 3 accounts at the same time no longer queues them — all selected accounts now start verifying simultaneously." },
    ],
  },
  {
    version: "1.0.377",
    date: "18 May 2026",
    items: [
      { category: "New", text: "Drag-and-drop column reordering is now available on the Dashboard activity log — grab any column header and drop it into position." },
      { category: "New", text: "Statistics page columns can now be reordered by dragging headers or using the up/down arrows in the Columns popup." },
      { category: "New", text: "Proxy Manager columns can now be reordered by dragging headers, and a new Columns popup lets you adjust their widths and order." },
    ],
  },
  {
    version: "1.0.376",
    date: "18 May 2026",
    items: [
      { category: "Fix", text: "Accounts that hit an Instagram security check during verify no longer falsely show as valid — the account card now correctly stays on the challenge status so you know it needs attention, even when the underlying API session is working." },
      { category: "Fix", text: "Verifying an account without the browser panel open no longer forces a fresh login — the app now navigates to Instagram first with your saved session before deciding if a re-login is needed, preventing unnecessary challenge triggers." },
      { category: "Fix", text: "Exporting accounts now includes the account status column so status (valid, stopped, captcha, etc.) is preserved exactly when you re-import the file." },
      { category: "Fix", text: "Importing accounts from an Equinox export now correctly restores each account's status instead of always resetting everything to pending." },
    ],
  },
  {
    version: "1.0.375",
    date: "18 May 2026",
    items: [
      { category: "Fix", text: "On startup, the app now automatically backfills the browser cookie file for any account that was imported before this fix — so accounts like terina_1967.pryor that were already in the database get the correct device identity without needing to be re-imported." },
    ],
  },
  {
    version: "1.0.374",
    date: "18 May 2026",
    items: [
      { category: "Fix", text: "Adding a profile manually from the Accounts page now seeds the browser cookie file if cookies are provided — same protection applied to bulk import, EQX import, and editing an existing account." },
    ],
  },
  {
    version: "1.0.373",
    date: "18 May 2026",
    items: [
      { category: "Fix", text: "Bulk import now also seeds the browser cookie file from the account's stored cookies — the same fix applied to EQX import in 1.0.372, so all import paths correctly pre-load device identity on first launch." },
    ],
  },
  {
    version: "1.0.372",
    date: "18 May 2026",
    items: [
      { category: "Fix", text: "EQX import now seeds the browser cookie file immediately from the account's stored cookies — so Chrome starts with the correct device identity (mid, ig_did, sessionid) on its very first launch instead of starting blank and triggering Instagram's contact point challenge." },
    ],
  },
  {
    version: "1.0.371",
    date: "18 May 2026",
    items: [
      { category: "Fix", text: "Embedded browser for challenge accounts no longer constantly reconnects every 4 seconds — a keepalive message now prevents the connection from being dropped while the account is parked waiting for verification." },
      { category: "Fix", text: "The Instagram verification link is now re-sent every time the browser panel reconnects, so the link stays visible and can be copied even after brief disconnects." },
    ],
  },
  {
    version: "1.0.370",
    date: "18 May 2026",
    items: [
      { category: "Fix", text: "EQX import now reliably preserves account status — verified accounts import as verified, banned as banned, etc. The previous fix wasn't working due to a database default overriding the imported value; this version forces the correct status with an explicit write after the account is created." },
    ],
  },
  {
    version: "1.0.369",
    date: "18 May 2026",
    items: [
      { category: "Fix", text: "Banned or restricted accounts now verify correctly — if Instagram accepted the login and set the session cookie, the account is marked verified even if the browser was redirected to an error page afterwards." },
      { category: "Fix", text: "Embedded browser no longer refreshes every 5 seconds for accounts on a restricted or ban page — the recovery loop now waits 30 seconds between retries instead of hammering constantly." },
    ],
  },
  {
    version: "1.0.368",
    date: "18 May 2026",
    items: [
      { category: "Fix", text: "Equinox now always appears first on the Windows taskbar — before any open browser windows. The main window minimises to the taskbar when closed instead of hiding, so its position never moves." },
      { category: "Fix", text: "Clicking the column headers on the Accounts page no longer crashes the app." },
    ],
  },
  {
    version: "1.0.367",
    date: "18 May 2026",
    items: [
      { category: "Fix", text: "EQX import now preserves the account status exactly as it was when exported — a verified account imports as verified, not as pending." },
      { category: "Fix", text: "EQX export/import now carries across all cookies and device state so nothing is lost when moving accounts between machines." },
    ],
  },
  {
    version: "1.0.366",
    date: "18 May 2026",
    items: [
      { category: "Fix", text: "EQX export/import now correctly preserves the assigned proxy — accounts linked via the Proxy Manager restore their proxy on import instead of losing it." },
      { category: "Fix", text: "Clicking Verify on an account with no proxy no longer leaves the button stuck on Verifying — it immediately returns to Verify Account." },
      { category: "Fix", text: "Browser login no longer reports a false success when the proxy blocked the redirect mid-login — you now get a clear message to open the embedded browser and complete any challenge shown." },
    ],
  },
  {
    version: "1.0.365",
    date: "18 May 2026",
    items: [
      { category: "Fix", text: "Account order on the Accounts page no longer changes when a status updates — the list stays in its current order until you click a column header." },
      { category: "Fix", text: "Copy Settings now remembers which accounts were selected the last time you opened it — selections are only cleared when you press NONE." },
    ],
  },
  {
    version: "1.0.364",
    date: "18 May 2026",
    items: [
      { category: "Fix", text: "Opening the embedded browser no longer blocks the toggle button or account settings in the same window." },
      { category: "Fix", text: "Copy Settings for the Contact tool now immediately applies the Start / Stop state to the target accounts — the tool stops or stays stopped straight away instead of waiting for the next cycle." },
    ],
  },
  {
    version: "1.0.363",
    date: "18 May 2026",
    items: [
      { category: "New", text: "Accounts with the same Instagram username are now highlighted in purple with a DUP badge so duplicates are immediately obvious." },
      { category: "Fix", text: "Copy Settings: selected accounts are now remembered when you close and reopen the dialog — only pressing NONE clears the selection." },
      { category: "New", text: "Copy Settings: ALL and NONE buttons are now always visible side by side so you can select or clear accounts in one click without toggling." },
      { category: "Fix", text: "Copy Settings: sorting by Name, Status, and Group now toggles between A→Z and Z→A each time you click the column header." },
      { category: "Fix", text: "Copy Settings account name column is now 15% wider so long usernames are less likely to be cut off." },
      { category: "Fix", text: "Account Settings username switcher dropdown is now 25% wider." },
      { category: "Fix", text: "Proxy IP field in Account Settings now uses a monospace font to match the IP column on the Accounts page." },
    ],
  },
  {
    version: "1.0.359",
    date: "18 May 2026",
    items: [
      { category: "Fix", text: "Account creator now uses the real browser CSRF token when creating accounts, matching the same cookie handover used by the login flow — fixes false 'email already taken' errors on clean proxies." },
      { category: "Fix", text: "Randomising the API agent in the account creator now also updates the EB (Chrome) user agent to the matching device model — both agents stay in sync." },
      { category: "New", text: "Account creator now shows the Chrome browser user agent used for the cookie harvest step, both in the config panel and in the step log." },
      { category: "Fix", text: "Going back to the Accounts page after viewing an account now reliably restores your scroll position — the previous fix had a React timing issue where the position was read as 0 on navigation." },
      { category: "New", text: "Account picker dropdown in account settings now shows the group each account belongs to." },
    ],
  },
  {
    version: "1.0.356",
    date: "17 May 2026",
    items: [
      { category: "New", text: "Embedded browser now has a + button to open a new tab, just like a real browser — you can browse freely in the new tab while keeping Instagram open on the first tab." },
      { category: "New", text: "On any tab after the first, the toolbar swaps to email shortcuts: Hotmail, OP.pl, and GMX buttons that navigate directly to those sites in one click." },
    ],
  },
  {
    version: "1.0.355",
    date: "17 May 2026",
    items: [
      { category: "Fix", text: "The 'Update Check Failed' error dialog no longer pops up on every app launch — background update checks now fail silently. The dialog only appears when you manually check for updates." },
      { category: "Fix", text: "Build pipeline no longer fails when the GitHub release token expires — the installer is always packaged and uploaded for download." },
    ],
  },
  {
    version: "1.0.353",
    date: "17 May 2026",
    items: [
      { category: "Fix", text: "Cookie injection now correctly decodes URL-encoded values (e.g. %3A → :) so the sessionid and other tokens are stored as the real value Instagram expects." },
      { category: "Fix", text: "Account creation no longer fails with 'EB cookie harvest returned no device cookies' — the browser now visits the Instagram homepage first to reliably seed mid and ig_did before proceeding to signup." },
    ],
  },
  {
    version: "1.0.352",
    date: "17 May 2026",
    items: [
      { category: "Fix", text: "Cookie injection now works correctly — pasted cookies are written to both the database and the browser cookie file, so the embedded browser automatically picks up the session on its next start without needing to clear anything first." },
      { category: "Fix", text: "Injecting cookies that include mid or ig_did now also updates the saved device fingerprint, so the mobile API and embedded browser both present the same device identity to Instagram." },
    ],
  },
  {
    version: "1.0.351",
    date: "17 May 2026",
    items: [
      { category: "Fix", text: "Account ordering on the Accounts page no longer jumps around when a status changes — the list only re-sorts when you click a column header." },
      { category: "Improve", text: "Exporting multiple accounts as EQX files now shows a single folder picker and saves all files at once, instead of opening a separate save dialog for each account." },
      { category: "New", text: "Account settings now has an Inject Session Cookies section — paste a raw cookie string (sessionid, ds_user_id, mid) and click Inject to restore a saved session without going through the embedded browser." },
    ],
  },
  {
    version: "1.0.350",
    date: "17 May 2026",
    items: [
      { category: "Fix", text: "Accounts no longer trigger 'Unrecognised device' security texts on subsequent logins — Chrome's own real-time device fingerprint (mid, datr) now always takes priority over the saved cookie file, preventing stale values from being silently restored at session startup." },
      { category: "Fix", text: "Embedded browser User-Agent and device metadata now fully match a real Android device, preventing Instagram from detecting automation via browser fingerprinting." },
      { category: "Fix", text: "Embedded browser no longer leaks the server's real IP address via WebRTC — all WebRTC connections are now routed through the assigned proxy." },
    ],
  },
  {
    version: "1.0.349",
    date: "16 May 2026",
    items: [
      { category: "Fix", text: "Embedded browser no longer constantly disconnects and shows 'Browser Disconnected — Reconnecting' every few seconds — Chrome now stays alive across brief connection drops and reconnects instantly." },
    ],
  },
  {
    version: "1.0.348",
    date: "16 May 2026",
    items: [
      { category: "Fix", text: "Accounts stuck on the 'This page isn't working' error now show Instagram's actual verification page in the embedded browser so you can complete the check directly." },
      { category: "Fix", text: "Account verification no longer breaks when re-verifying an account that previously had a challenge — the stale challenge state is now cleared at the start of each new attempt." },
    ],
  },
  {
    version: "1.0.347",
    date: "16 May 2026",
    items: [
      { category: "Fix", text: "Reverted browser session changes to restore working verification — account verify is back to the stable 1.0.343 behaviour." },
      { category: "Fix", text: "Importing a profile (.eqx file) now works correctly — large exports were being silently rejected before reaching the import step." },
    ],
  },
  {
    version: "1.0.346",
    date: "16 May 2026",
    items: [
      { category: "Fix", text: "Importing a profile (.eqx file) now works correctly — large exports were being silently rejected before reaching the import step." },
    ],
  },
  {
    version: "1.0.345",
    date: "16 May 2026",
    items: [
      { category: "Fix", text: "When Instagram requires account verification, the embedded browser now clears the stale session before loading the challenge page — fixing the 'This page isn't working' / ERR_TOO_MANY_REDIRECTS loop that prevented the challenge from appearing." },
    ],
  },
  {
    version: "1.0.344",
    date: "16 May 2026",
    items: [
      { category: "Fix", text: "When Instagram detects an unrecognised browser and requires account verification, the embedded browser now shows Instagram's actual verification page instead of a blank 'This page isn't working' error." },
    ],
  },
  {
    version: "1.0.343",
    date: "16 May 2026",
    items: [
      { category: "Fix", text: "Embedded browsers no longer freeze permanently when 5 or more are open at the same time — the previous release introduced a frame-rate reduction that stopped Chrome from ever sending the first image, this is now corrected." },
      { category: "Improve", text: "When opening multiple browsers simultaneously each one now starts its live view in sequence with a short gap between them, keeping the connection responsive without any visible delay to the user." },
    ],
  },
  {
    version: "1.0.342",
    date: "16 May 2026",
    items: [
      { category: "Fix", text: "Opening multiple embedded browsers at the same time no longer causes them to freeze — each browser now starts its live view in sequence instead of all competing for the same connection at once." },
      { category: "Fix", text: "With 5 or more browsers open simultaneously, the frame rate per browser now scales down proportionally so the total load on the connection stays constant, keeping all browsers responsive." },
    ],
  },
  {
    version: "1.0.341",
    date: "16 May 2026",
    items: [
      { category: "Fix", text: "Accounts that get a challenge or suspension response from Instagram while running timeline likes, timeline feed, or story views now correctly stop and update their status — previously they silently logged 0 actions and kept running." },
      { category: "Fix", text: "Embedded browser no longer shows 'Retry' after around 60 seconds on a static page — the health check now waits longer before deciding the browser is unresponsive, and gives it a second chance before closing." },
      { category: "Fix", text: "Fifth or more embedded browsers opening at the same time no longer freeze permanently — a timeout was added so a stuck session setup fails fast and retries instead of hanging indefinitely." },
      { category: "New", text: "Dashboard activity feed now has a 'Show only errors' button that filters the list to just error entries, making it quicker to spot problem accounts." },
    ],
  },
  {
    version: "1.0.340",
    date: "16 May 2026",
    items: [
      { category: "Fix", text: "The follow tool no longer keeps running if an account has a genuine error status (such as phone verification required, email confirmation, or session expired) — it now pauses correctly until the account is resolved." },
      { category: "Fix", text: "Human session, unfollow, and DM tools now all correctly detect account-level errors (checkpoint, session expired, etc.) that bubble up from a session and update the account status immediately, stopping further runs." },
      { category: "Fix", text: "Security challenge detected in the embedded browser no longer overwrites an account that has been manually stopped." },
    ],
  },
  {
    version: "1.0.339",
    date: "16 May 2026",
    items: [
      { category: "Fix", text: "Opening a browser for an account that already has one open now brings that window to focus instead of launching a second one — one browser window per account at a time." },
      { category: "Fix", text: "After logging in via the embedded browser, the account status now immediately updates to its real value (Valid, Captcha, 2FA, etc.) without needing to also click Verify Account." },
      { category: "Fix", text: "The debug log panel no longer pops open automatically when you click the Login button inside the embedded browser — it stays hidden unless you press F12." },
      { category: "Fix", text: "Chrome processes left running in the background after closing an embedded browser panel are now properly shut down, preventing phantom Chrome instances from accumulating in Task Manager." },
      { category: "New", text: "Activity log on the Dashboard now has an Export CSV button so you can download a copy of the filtered log." },
      { category: "New", text: "Accounts, Dashboard, and Statistics pages now restore your scroll position when you navigate back to them." },
    ],
  },
  {
    version: "1.0.338",
    date: "16 May 2026",
    items: [
      { category: "Fix", text: "Status label corrected to 'Confirm Your Human' (was 'Confirm Human')." },
    ],
  },
  {
    version: "1.0.337",
    date: "16 May 2026",
    items: [
      { category: "New", text: "When an account's embedded browser lands on Instagram's 'We've disabled your account' page, the account status now immediately updates to 'Account Disabled' — previously the status stayed unchanged and gave no indication the account was gone." },
      { category: "Change", text: "The 'Suspended' status has been renamed to 'Confirm Human'. This status appears when Instagram is asking the account to complete a human verification challenge, not when it has been suspended in the traditional sense." },
    ],
  },
  {
    version: "1.0.336",
    date: "16 May 2026",
    items: [
      { category: "Fix", text: "Embedded browsers now automatically fill and submit login credentials as soon as the login page is detected after opening — no manual button press required. The browser opens, detects it is on the Instagram login form, and starts typing within a few seconds." },
      { category: "Fix", text: "The 'Debug panel … F12' bar no longer appears at the bottom of each embedded browser window. The debug panel is still accessible via F12 if needed but no longer shows automatically." },
      { category: "Fix", text: "When the server detects a stalled screen stream and restarts it, the 'Browser appears frozen' overlay now correctly clears itself as soon as the restart is confirmed — instead of requiring the user to click 'Keep Waiting'. The frozen timer is also reset so it does not fire again immediately after the restart." },
      { category: "Fix", text: "With many embedded browsers open simultaneously, Chrome's compositor was being overwhelmed sending too many video frames at once and would stall completely. The frame rate is now reduced automatically as more browsers open: full speed for up to 5, halved for 6–10, one-third speed for 11–20, and one-quarter for 21 or more. This should allow 25+ browsers to run without freezing." },
    ],
  },
  {
    version: "1.0.335",
    date: "16 May 2026",
    items: [
      { category: "Fix", text: "Active embedded browsers no longer show 'Browser page is unresponsive — Click Retry to restart' incorrectly. The health check was being routed through the screen-streaming connection, which backs up under heavy load and falsely appeared frozen even when Chrome was perfectly fine. The check now uses a completely separate connection to Chrome so a congested screen stream can never trigger a false alarm." },
      { category: "Fix", text: "When the screen stream stalls mid-session on an active browser (frames stop arriving while Chrome is running fine), the app now silently restarts just the stream connection and continues — the browser, its cookies, and the current page are all preserved. Previously this would incorrectly kill the entire browser session and show a Retry error." },
      { category: "Fix", text: "Auto-login now correctly handles Instagram's current splash page, which shows 'Log in' as a button rather than a link. Previously the app failed to detect the splash and assumed the account was already logged in. It now detects both button and link versions of the splash and clicks through automatically so credentials are filled without any manual interaction." },
      { category: "Fix", text: "The F12 developer tools panel no longer appears in the installed app. It is still available in development but is now hidden in the packaged build." },
      { category: "Fix", text: "Exported API call history is no longer lost when the app is restarted. The previous limit of 5000 rows was too low — a single Verify All run on 100 accounts inserts around 1000 rows, meaning just a few restarts erased the entire history. The limit is now 1,000,000 rows, which is effectively unlimited for real-world usage." },
      { category: "Improvement", text: "The Actions menu on the Accounts page now shows the keyboard shortcut next to each option that has one: Open Browsers (Ctrl+O), Login Embedded Browsers (Ctrl+L), Verify Accounts (Ctrl+R), Fix Captcha (Ctrl+F), Remove Proxies (Ctrl+P), Ungroup Accounts (Ctrl+C), Delete Selected (Ctrl+D)." },
    ],
  },
  {
    version: "1.0.333",
    date: "16 May 2026",
    items: [
      { category: "Fix", text: "Embedded browsers that were previously stuck on 'Loading Instagram, please wait' even after the screen stream started will now automatically recover within 8 seconds. If Chrome does not deliver a single video frame within 8 seconds of the stream starting (which can happen when 5 or more browsers are opened at once and the CPU is under heavy load), the stream is stopped and immediately restarted without any user action required." },
      { category: "Diagnostic", text: "The log now shows the exact moment Chrome delivers its first video frame to each embedded browser, and confirms when the 'stream ready' signal is sent to the panel — making it much easier to pinpoint which browser is stalling and why." },
    ],
  },
  {
    version: "1.0.332",
    date: "16 May 2026",
    items: [
      { category: "Fix", text: "Opening 4 or more embedded browsers at the same time no longer leaves some of them stuck on 'Loading Instagram, please wait' forever. The root cause was a timing race in Chrome's screen-streaming protocol: Chrome sends the very first screen frame the instant it receives the start command, but the old code registered the frame handler a moment too late, causing the frame to be silently dropped. Chrome then waits indefinitely for an acknowledgement that never comes and stops sending any further frames. The fix registers the handler before sending the start command, so no frame can ever be missed." },
      { category: "Fix", text: "When the embedded browser screen pipeline is confirmed active the 'Loading…' overlay now clears immediately instead of waiting up to 45 seconds for the first large content frame." },
      { category: "Fix", text: "If the browser window is closed while Chrome is still starting up, the cleanup handler now fires correctly so the session is not left pointing at a dead connection." },
    ],
  },
  {
    version: "1.0.331",
    date: "16 May 2026",
    items: [
      { category: "Fix", text: "Embedded browser crash detector no longer misfires on static pages. It now sends a real ping to Chrome and only closes the session if Chrome genuinely fails to respond — previously any page that stopped updating frames (such as a loaded login page) would trigger a false crash after 60 seconds." },
      { category: "Fix", text: "When Instagram returns a checkpoint, email confirmation, or session-expired error during a DM check or other tool run, the account status now updates immediately in the database instead of staying unchanged." },
      { category: "UI", text: "Account submenu order changed: Account Settings stays first, then Follow Tool, Unfollow Tool, Contact Tool, Human Session Tools, Session Log, Create a Cookie. A small gap separates Account Settings from the tools below it." },
      { category: "UI", text: "Shortcut numbers removed from the account submenu." },
      { category: "UI", text: "Submenu chevrons are now solid black (white in dark mode)." },
      { category: "UI", text: "Sorting the Accounts list by clicking a column header now toggles between A-Z and Z-A only — the third 'reset sort' state has been removed." },
    ],
  },
  {
    version: "1.0.330",
    date: "16 May 2026",
    items: [
      { category: "Fix", text: "Clicking Verify Account no longer immediately goes red. If the embedded browser is already logged in, Verify now correctly detects that and proceeds straight to the cookie handover — it no longer falsely reports 'account locked' when a previous challenge flag was left over from an earlier session." },
      { category: "Fix", text: "Clicking inside the embedded browser (menus, links, etc.) no longer causes a flash followed by the browser crashing and showing a Retry button. The crash detector was firing too eagerly right after a click because a static page sends no screen frames — giving the impression Chrome had frozen. It now waits at least 10 seconds after any interaction before checking, giving Chrome time to respond." },
    ],
  },
  {
    version: "1.0.329",
    date: "16 May 2026",
    items: [
      { category: "Fix", text: "When the DM check actually fails (no session cookies, network error, or Instagram returned an error), the activity bar now says 'DM check failed' in red — previously it said 'Checked 0 direct messages' which looked like a normal empty inbox." },
      { category: "Fix", text: "Group dropdown in account settings now shows all existing groups when you open it, regardless of which group is currently assigned — previously it only showed groups matching the current value, hiding everything else." },
      { category: "Fix", text: "Cookie Baker copy settings was silently copying nothing to target accounts. It now correctly copies whichever settings you select (interval, sites, scroll delay, etc.)." },
    ],
  },
  {
    version: "1.0.328",
    date: "16 May 2026",
    items: [
      { category: "Fix", text: "The activity bar at the top of the screen no longer shows red text when a DM check comes back with zero messages — red is now reserved for genuine errors such as a blocked follow, a blocked DM, or a failed verification." },
    ],
  },
  {
    version: "1.0.327",
    date: "16 May 2026",
    items: [
      { category: "Fix", text: "Fixed embedded browsers becoming unresponsive when 4 or more are open at the same time — the root cause was that frame streaming and click handling shared the same Chrome communication channel, so a slow frame would block every click for up to 8 seconds. Frame delivery is now handled on a completely separate channel, so clicks and typing are always instant regardless of how many browsers are open." },
      { category: "Improvement", text: "The embedded browser now uses Chrome's built-in screen-sharing API to push frames instead of taking periodic screenshots — this removes the need for a screenshot queue entirely and makes the session feel much more responsive." },
    ],
  },
  {
    version: "1.0.326",
    date: "16 May 2026",
    items: [
      { category: "Fix", text: "Account status pills now update instantly when the automation engine changes an account's status — no more waiting up to 5 seconds to see the result." },
      { category: "Fix", text: "The embedded browser login progress log is now always visible as soon as a login attempt starts." },
      { category: "Fix", text: "Verify no longer gets stuck on 'Verifying' if an unexpected error occurs mid-flow — it now always resolves to a final status." },
      { category: "Fix", text: "Added 'Locked' as a recognised account status with its own badge, so accounts reported as locked by Instagram display correctly instead of falling through to an unknown state." },
      { category: "UX", text: "Keyboard shortcuts on the account page: press 1–7 (without modifier keys, when not typing in a field) to jump directly to any tab. The shortcut number is shown next to each action in the sidebar." },
    ],
  },
  {
    version: "1.0.325",
    date: "15 May 2026",
    items: [
      { category: "Fix", text: "Fixed 'Unrecognized device' security alerts from Instagram — the login process was accidentally wiping the device identity cookies (Machine ID, Device ID) before logging in, making Instagram think it was a brand new device every time. These are now always preserved." },
      { category: "Fix", text: "Fixed the API tools (follow, unfollow, DM, etc.) not reading the embedded browser's live session in the installed app — they were looking in the wrong folder for the session cookies and silently falling back to stale or missing sessions." },
      { category: "Fix", text: "Device fingerprints (Machine ID, Device ID, Phone ID, Advertising ID) are now strictly preserved across all code paths and never randomly regenerated mid-session — they only reset when you explicitly press Reset Device IDs." },
      { category: "Fix", text: "Chrome's browser profile folder is now stored in a permanent location next to the database instead of the Windows temp folder, so it survives OS restarts and temp-folder cleanups." },
    ],
  },
  {
    version: "1.0.324",
    date: "15 May 2026",
    items: [
      { category: "Fix", text: "Fixed a critical bug where clicking anything in the embedded browser (including the Instagram login button) did nothing when 5 or more browsers were open at the same time. The browser frame stream now uses WebSocket instead of a plain HTTP connection, so it no longer takes up one of the browser's limited connection slots — leaving those slots free for clicks and other actions regardless of how many browsers are open." },
    ],
  },
  {
    version: "1.0.321",
    date: "15 May 2026",
    items: [
      { category: "Fix", text: "Opening multiple browsers at once no longer causes all of them to freeze. The frame rate for each browser now scales down based on how many are open at the same time, keeping the total workload manageable. With 10 open browsers you get a smooth ~2 fps each instead of all of them competing at full speed and crashing." },
    ],
  },
  {
    version: "1.0.320",
    date: "15 May 2026",
    items: [
      { category: "UX", text: "Accounts added via Add Profile or Bulk Import with no group are now automatically placed into a group called 'No Group Assigned' instead of having no group at all." },
      { category: "UX", text: "The Copy Settings account list now shows Account Name, Label, Status, and Group in aligned columns — click any column header to sort by that field." },
      { category: "UX", text: "The Copy Settings group selector now includes 'No Group Assigned' so you can select all ungrouped accounts in one click." },
      { category: "UX", text: "Removed the 'Idle' status badge from the account cards — only Running and Error states are shown as badges now." },
    ],
  },
  {
    version: "1.0.319",
    date: "15 May 2026",
    items: [
      { category: "Fix", text: "Watch Stories in the Human Session tool no longer shows 'no mobile session' for accounts that have already been verified. The verified session is now preserved during automation runs instead of being replaced by the embedded browser session." },
      { category: "Fix", text: "The dashboard now shows a more accurate message when Watch Stories is skipped: 'session expired or rejected — re-run Verify Credentials to refresh' instead of the generic 'no mobile session' message." },
    ],
  },
  {
    version: "1.0.318",
    date: "15 May 2026",
    items: [
      { category: "Fix", text: "Export EQX now works with any number of selected accounts — each account downloads as its own .eqx file. Previously only 1-account export worked reliably; multi-select was routed to a ZIP bundle that didn't always trigger correctly in Electron." },
      { category: "Fix", text: "Accounts created via the Create button no longer have their group set to 'Ungrouped'. New accounts with no group assigned have an empty group tag and appear in the list without any group heading." },
      { category: "Fix", text: "Accounts with no group tag no longer appear under an 'Ungrouped' section header in group view — they render as flat rows with no heading. Accounts that do have a group still show the collapsible group header." },
      { category: "UX", text: "Account Settings > Generate Code no longer shows the code on screen. It copies the 6-digit TOTP code to clipboard immediately and the button briefly shows 'Copied!' to confirm." },
    ],
  },
  {
    version: "1.0.317",
    date: "15 May 2026",
    items: [
      { category: "Fix", text: "Multi-EB freeze — three root causes fixed: (1) Activity-based frame rate: each EB now tracks the last time the user sent input (click, scroll, key, navigate). The active EB runs at full ~6.7 fps; an EB idle for 3–30 s drops to ~0.8 fps; dormant EBs (>30 s no input) drop to ~0.33 fps. Background EBs therefore stop competing for screenshot slots, leaving full capacity for the one being used. (2) Thundering herd: frame loops now start at a small deterministic offset per profile (0–400 ms) so all EBs don't fire simultaneously on the same tick and saturate the global limiter in lockstep. (3) Adaptive JPEG quality: encoding cost scales down from 70 → 60 → 45 as the number of open sessions increases, reducing CPU pressure when many EBs are open." },
      { category: "Fix", text: "Keep-alive SSE comment is now always written every ~15 s regardless of idle state — previously it was gated behind the idle-skip check, which would have caused proxy disconnects on dormant EBs." },
    ],
  },
  {
    version: "1.0.316",
    date: "15 May 2026",
    items: [
      { category: "Fix", text: "Root cause fix for accounts getting hammered into Instagram security locks. The embedded browser now tracks security challenge redirects on the session object. If a challenge is detected, any subsequent Verify attempt returns an error immediately without clearing cookies or re-submitting credentials — stopping the re-login loop that caused Instagram to deepen the lock. Previously, each retry would wipe cookies and submit credentials again (from headless Chrome) which Instagram counted as repeated suspicious logins." },
      { category: "Fix", text: "chrome-error:// pages (ERR_TOO_MANY_REDIRECTS) are no longer mis-classified as a successful login. Previously, the post-submit check treated any page that wasn't the login form as 'logged in', which caused the verify route to call the mobile API, which returned login_required, which caused the user to retry, which started the cookie-clear-and-resubmit loop again." },
    ],
  },
  {
    version: "1.0.315",
    date: "15 May 2026",
    items: [
      { category: "Fix", text: "Embedded browser now detects Instagram account security locks and shows a clear message explaining what to do, instead of showing a blank error page. Chrome returns to the login screen automatically after the lock is detected." },
      { category: "Fix", text: "Confirmed the embedded browser always uses the account's assigned proxy — the direct connection flag is ignored when a proxy is configured." },
    ],
  },
  {
    version: "1.0.314",
    date: "15 May 2026",
    items: [
      { category: "Fix", text: "Removed all redirect-recovery logic from the login flow. Login now succeeds and shows Instagram, or fails cleanly — no cookie clearing, no retry navigation, no frame loop auto-navigation on error pages." },
    ],
  },
  {
    version: "1.0.313",
    date: "15 May 2026",
    items: [
      { category: "Fix", text: "ERR_TOO_MANY_REDIRECTS — when both recovery gotos ALSO hit chrome-error:// (i.e. the redirect loop is account-level and persists even with just the sessionid re-injected), the app no longer falsely reports 'Login successful' while Chrome is stuck on the error page. Instead: the saved cookie JSON is deleted (so the next EB open shows the login form rather than immediately looping again), Chrome's cookie jar is cleared, Chrome navigates to the login page (which never redirect-loops with no cookies), and the log reports failure honestly. Previously the recovery could leave Chrome permanently stuck on chrome-error:// while the log showed a green success tick." },
    ],
  },
  {
    version: "1.0.312",
    date: "15 May 2026",
    items: [
      { category: "Fix", text: "Eliminated the infinite ERR_TOO_MANY_REDIRECTS crash loop caused by three compounding bugs: (1) phantom loginDone — stale autoLogin running on a killed Chrome session fired a false 'Login successful' event on the newly-launched Chrome; fixed by capturing a session token at autoLogin start and aborting silently if the session was replaced before return. (2) clearSession wiped the saved sessionid — pressing Clear deleted the cookies JSON so the next Chrome had to log in fresh and hit the same redirect loop again; fixed by removing deleteSavedCookies from clearSession (Chrome-profile stale cookies are already purged by getOrCreateSession on launch). (3) No UI warning — user pressed Clear mid-recovery not knowing login had already succeeded; fixed by a new amber warning overlay 'Recovery In Progress — Do NOT press Clear' that appears as soon as the redirect loop is detected and disappears when loginDone fires." },
    ],
  },
  {
    version: "1.0.311",
    date: "15 May 2026",
    items: [
      { category: "Fix", text: "ERR_TOO_MANY_REDIRECTS crash loop fully resolved — root cause was conflicting cookies remaining in Chrome's jar after login. Recovery now reads the sessionid value, wipes ALL instagram.com cookies from Chrome via CDP, re-injects only sessionid, then navigates to instagram.com — breaking the redirect chain at the source. Applies to both the 2FA and non-2FA login paths." },
      { category: "Fix", text: "attachSSE session-check now uses explicit domain fetch (page.cookies('https://www.instagram.com')) instead of the no-arg form which returns empty on chrome-error:// pages. Also checks lastLoginSuccessAt so a fresh login is not treated as a missing session." },
      { category: "Fix", text: "Screenshot timeout #3 early-recovery goto now stands down for 90 s after a successful login, preventing a competing navigation that could race with and crash the autoLogin recovery flow." },
      { category: "UI", text: "Account Settings page nav links (Back to Accounts, Dash, Browser, Account Settings, Copy Settings) moved to their own row above the account status pill and profile picker." },
    ],
  },
  {
    version: "1.0.310",
    date: "15 May 2026",
    items: [
      { category: "UI", text: "Session Cookie indicator moved inline — now sits directly next to the Reset Device IDs button (Session Cookie: Passed / Not set) instead of in a separate row at the bottom of the Account Details card." },
    ],
  },
  {
    version: "1.0.309",
    date: "15 May 2026",
    items: [
      { category: "Fix", text: "EB panel stuck on ERR_TOO_MANY_REDIRECTS after login — two root causes fixed: (1) the recovery goto to instagram.com now retries up to 3×  with backoff if Chrome's renderer is still processing the error page, rather than giving up silently and leaving the panel frozen; (2) the frame-loop no longer clears session cookies and navigates back to the login page when a successful login completed within the last 90 s — it now navigates to instagram.com instead, so the cookies that were just saved are preserved rather than wiped out." },
    ],
  },
  {
    version: "1.0.308",
    date: "15 May 2026",
    items: [
      { category: "Docs", text: "Internal documentation updated to reflect the Jarvee two-stage login flow introduced in v1.0.307 — no user-facing changes." },
    ],
  },
  {
    version: "1.0.307",
    date: "15 May 2026",
    items: [
      { category: "Verify", text: "Fixed: Accounts were being marked 'Valid' the moment a sessionid cookie was found in the embedded browser — before confirming that cookie actually works at the mobile API layer. Jarvee's real flow is: EB login → grab cookies → hand to API → API makes cold-start calls (tokens/keyed, launcher/sync, users/info) → ONLY THEN mark valid. The EB cookies are now saved immediately after extraction (so they survive even a transient API failure), then the mobile API validation runs, and the final account status is set by the API result, not the EB result. Both the single-account Verify and bulk verify paths have been updated." },
    ],
  },
  {
    version: "1.0.306",
    date: "15 May 2026",
    items: [
      { category: "Account Settings", text: "Added: Session Cookie indicator in the Account Details card. Shows a green 'Passed to API' badge if the EB login successfully handed a sessionid cookie to the automation engine, or an amber 'Not set — run Verify' badge if no session has been established yet. The indicator updates live whenever the account page is open." },
    ],
  },
  {
    version: "1.0.305",
    date: "15 May 2026",
    items: [
      { category: "Login", text: "Fixed: After clicking Log In, the app was giving up after only 5 seconds and reporting failure — even though Instagram had actually accepted the credentials. The root cause was a text-matching bug in the post-submit wait: the code was watching for Instagram's old UI copy ('email or mobile number') which no longer exists, so the wait resolved instantly. Replaced with a DOM-based check that detects when the login form disappears or when Instagram enters the redirect loop, with the timeout extended to 20 seconds to handle slow proxy responses." },
    ],
  },
  {
    version: "1.0.304",
    date: "15 May 2026",
    items: [
      { category: "Login", text: "Fixed: Silent login failure in the embedded browser — if Chrome had a stale sessionid cookie loaded from a previous session, Instagram's login endpoint would silently bounce the form back to the login page with no error message. The app now clears session-identity cookies (sessionid, ds_user_id, rur, ps_l, ps_n) immediately before every login attempt, while keeping device fingerprint cookies (datr, ig_did, mid) and the CSRF token. First-login attempts now succeed on the first try instead of requiring a full session delete and Chrome restart." },
      { category: "Logs", text: "Fixed: HTTP log entries now show the account label (the friendly name assigned in account settings) instead of the raw Instagram username. If no label is set, the username is used as a fallback. e.g. 'POST /api/browser/1209 [Cecilia Main] 200 5ms'." },
    ],
  },
  {
    version: "1.0.303",
    date: "15 May 2026",
    items: [
      { category: "Engine", text: "Fixed: When a runner (follow, unfollow, DM, contact, human session) crashed mid-session, the engine's 10-second reconcile loop was re-launching it immediately with no delay — the same as a user manually enabling a tool. The crashed runner now receives the same random X-Y startup delay as a cold app launch, preventing crash/restart loops from hammering Instagram." },
      { category: "Logs", text: "Improved: HTTP request logs now show the account username alongside the profile ID for all browser and profile endpoints. e.g. 'POST /api/browser/1209 [@CeciliaCelineLumas] 200 12ms'. If the username is not yet in cache, the numeric ID is shown as [#1209] until the engine's next reconcile populates it." },
    ],
  },
  {
    version: "1.0.302",
    date: "15 May 2026",
    items: [
      { category: "Browser", text: "Fixed: Chrome lock files (SingletonLock, SingletonSocket, SingletonCookie) left behind by a previously crashed or force-killed EB were preventing new Chrome instances from launching ('The browser is already running for <path>'). These files are now deleted unconditionally before every launch — harmless if Chrome was not running, essential if it was killed without cleanup." },
    ],
  },
  {
    version: "1.0.301",
    date: "14 May 2026",
    items: [
      { category: "Browser", text: "Fixed: Stale Instagram cookies left in Chrome's persistent profile directory were causing ERR_TOO_MANY_REDIRECTS on every EB open, before any credentials were entered. Chrome now purges all instagram.com cookies at launch before applying the saved clean session, so the initial navigation always starts from a known-good state." },
      { category: "Automation", text: "Fixed: The mobile API device ID (ig_did) and machine ID (mid) were being regenerated on every automation cycle (~every 10 minutes). Instagram uses these to identify the device — changing them constantly looks like a new device login every run, which is a primary cause of account locking. These IDs are now generated once and reused for the entire session." },
      { category: "Debugging", text: "Improved: loadBrowserCookies and mobileBootstrapFromWebCookies now log the full list of cookie names synced, whether sessionid was found, and whether device IDs are new or reused — visible in server logs to help trace cookie passover failures." },
    ],
  },
  {
    version: "1.0.300",
    date: "14 May 2026",
    items: [
      { category: "Browser", text: "Fixed: The frame loop's error-page recovery was firing concurrently with the post-2FA redirect-loop recovery, clearing the just-set sessionid cookie and navigating back to the login page — undoing the successful login. The frame loop now stands down completely while auto-login is in progress, letting browserAutoLogin handle the chrome-error:// state on its own." },
    ],
  },
  {
    version: "1.0.299",
    date: "14 May 2026",
    items: [
      { category: "Browser", text: "Fixed: After passing 2FA, Instagram's post-login redirects sometimes end in ERR_TOO_MANY_REDIRECTS (chrome-error:// page). The session cookie was already set by Instagram before the loop but couldn't be read because the browser was on an error page. The app now: (1) reads Instagram cookies by domain directly — bypassing the current page URL — so cookies are always retrievable regardless of what page Chrome is on; (2) automatically navigates back to instagram.com after detecting the redirect loop so the embedded browser shows your account instead of an error page." },
    ],
  },
  {
    version: "1.0.298",
    date: "14 May 2026",
    items: [
      { category: "Architecture", text: "Removed: Cold mobile API login fallback that could fire during automation. If the embedded browser cookie file existed but had no sessionid, the engine would silently fall back to a direct mobile API password login — bypassing the browser entirely. This is now removed. Mobile-API tools are skipped with a warning instead, and re-verifying the account restores them cleanly." },
      { category: "Help", text: "Updated: The 'What does Verify Account do?' help text now correctly describes the browser-first login flow." },
    ],
  },
  {
    version: "1.0.297",
    date: "14 May 2026",
    items: [
      { category: "Verify", text: "Fixed: Verify All was using direct mobile API login (Path 1) instead of the Jarvee-style EB-first flow. It now follows the same path as single-account Verify: launch embedded browser → web login → extract sessionid/csrftoken/ds_user_id/mid from Chrome → save to DB. Direct mobile API logins look like new-device takeovers to Instagram and risk account locks." },
    ],
  },
  {
    version: "1.0.296",
    date: "14 May 2026",
    items: [
      { category: "Browser", text: "Fixed: Random embedded browser freezes (screenshot timeouts, chrome-error://) affecting different accounts on every startup with no pattern. Root cause: headless Chrome on Windows still spins up a GPU process, and when multiple EBs launch at the same time they race for GPU resources — whichever loses gets a frozen renderer. Added --disable-gpu and --disable-software-rasterizer to Chrome launch flags, forcing software rendering and eliminating the race condition entirely." },
    ],
  },
  {
    version: "1.0.295",
    date: "14 May 2026",
    items: [
      { category: "Browser", text: "Fixed: Before launching Chrome, the app now tests whether the proxy is actually reachable (6-second TCP check). A dead proxy causes Chrome's renderer to freeze completely — screenshots time out, the error recovery never fires, and the browser enters a 40-second crash loop. Failing fast at launch prevents this entirely and shows a clear 'proxy unreachable' message instead." },
      { category: "Browser", text: "Fixed: Proxy failures (ERR_PROXY_CONNECTION_FAILED, ERR_TUNNEL_CONNECTION_FAILED) were being treated the same as redirect loops — cookies were deleted even though they were perfectly valid. The app now reads the Chrome error page title to distinguish proxy errors from cookie/redirect errors, and only clears cookies for the latter." },
      { category: "Browser", text: "Fixed: When Chrome froze completely (5 screenshot timeouts in a row), the app was deleting saved cookies before closing Chrome. Since complete freezes are caused by dead proxies — not bad cookies — this was destroying valid Instagram sessions unnecessarily. Cookies are now preserved on proxy-freeze crashes." },
    ],
  },
  {
    version: "1.0.294",
    date: "14 May 2026",
    items: [
      { category: "Browser", text: "Fixed: Embedded browsers that froze completely (screenshot timed out repeatedly) were reusing the same broken Chrome process on every reconnect, causing an endless crash loop. Chrome is now fully closed when this happens so the next open always starts fresh." },
    ],
  },
  {
    version: "1.0.293",
    date: "14 May 2026",
    items: [
      { category: "Browser", text: "Fixed: Embedded browsers were getting stuck on the 'This page isn't working — ERR_TOO_MANY_REDIRECTS' error screen and never recovering. Stale saved cookies that caused the redirect loop are now properly cleared (they weren't being found before because the browser was on an error page, not Instagram), and the recovery now fires within 3 seconds instead of waiting up to 25 seconds." },
    ],
  },
  {
    version: "1.0.292",
    date: "14 May 2026",
    items: [
      { category: "Security", text: "Fixed: Accounts were being flagged or locked because a security-token request was accidentally sent with the account's active login cookie to an Instagram endpoint that is only meant to be called before any login — now that request is sent anonymously, matching how the real Instagram app behaves." },
      { category: "Security", text: "Fixed: Automation could contact Instagram's API on accounts that had never been logged in through the browser first — the engine now waits until browser verification is complete before doing anything." },
      { category: "Accounts", text: "Fixed: Accounts in Pending status (never verified) were allowed to run automation tools — they now pause and wait until Verify Credentials has been run successfully." },
    ],
  },
  {
    version: "1.0.291",
    date: "14 May 2026",
    items: [
      { category: "Browser", text: "Fixed: Embedded browsers were freezing indefinitely — Puppeteer's internal screenshot timeout was silently resetting the crash detector counter instead of incrementing it, so Chrome hung pages were never recovered." },
      { category: "Accounts", text: "Fixed: Accounts flagged as bad_password when the real cause was an account lock, security challenge, or new-device block — the mobile login error is now inspected before deciding whether the password is actually wrong." },
    ],
  },
  {
    version: "1.0.290",
    date: "14 May 2026",
    items: [
      { category: "Accounts", text: "The Select All button on the Accounts page now shows a count of how many accounts are currently selected next to it." },
    ],
  },
  {
    version: "1.0.289",
    date: "14 May 2026",
    items: [
      { category: "Browser", text: "Fixed: The embedded browser would permanently stay stuck on the ERR_TOO_MANY_REDIRECTS error screen — the redirect-loop recovery now reliably fires within 3 seconds and keeps retrying every 30 seconds if the first attempt doesn't work." },
    ],
  },
  {
    version: "1.0.288",
    date: "14 May 2026",
    items: [
      { category: "Fix", text: "Watch Stories / Watch Reels: Fixed \"Skipped: no mobile session\" appearing even after running Verify Credentials — the mobile API session is now always refreshed from the current embedded browser session, so it cannot be stale." },
      { category: "Accounts", text: "New accounts added without a group are now automatically placed into a group called \"Ungrouped\" instead of floating outside any group." },
    ],
  },
  {
    version: "1.0.287",
    date: "14 May 2026",
    items: [
      { category: "Browser", text: "Fixed: Opening 5 or more browsers at the same time no longer causes them to freeze — screenshot operations are now limited to 3 at a time and staggered so they don't all compete for the CPU simultaneously." },
    ],
  },
  {
    version: "1.0.286",
    date: "14 May 2026",
    items: [
      { category: "Browser", text: "Fixed: The embedded browser no longer shows a blank white screen when opening — it now waits until the page has actually loaded before removing the loading indicator." },
    ],
  },
  {
    version: "1.0.285",
    date: "14 May 2026",
    items: [
      { category: "Updates", text: "Fixed: The automatic update checker was failing with an authentication error — the app now correctly authenticates when checking for new versions." },
      { category: "Browser", text: "Fixed: The embedded browser could freeze permanently when landing on a suspended Instagram account page — it now detects the freeze and closes the session cleanly instead of hanging forever." },
    ],
  },
  {
    version: "1.0.283",
    date: "14 May 2026",
    items: [
      { category: "Browser", text: "Fixed: When Instagram gets into a redirect loop (ERR_TOO_MANY_REDIRECTS), the browser now automatically clears the bad session cookies and returns to the login page after 3 seconds instead of staying stuck on the error screen." },
      { category: "Browser", text: "Fixed: Clicking links and buttons in the embedded browser is now more reliable — buttons, links, and interactive elements that previously required multiple clicks now respond on the first click." },
    ],
  },
  {
    version: "1.0.282",
    date: "13 May 2026",
    items: [
      { category: "Internal", text: "Fixed: CI build failure caused by a missing file — the TOTP code generator was created locally but never included in the repository." },
    ],
  },
  {
    version: "1.0.281",
    date: "13 May 2026",
    items: [
      { category: "Accounts", text: "Fixed: Adding a new account no longer pre-fills a random username or the word 'password' — both fields now start completely blank." },
    ],
  },
  {
    version: "1.0.280",
    date: "13 May 2026",
    items: [
      { category: "Verify Account", text: "Fixed: Disabled accounts now correctly show as Disabled instead of Valid. Instagram allows a disabled account to complete the login and 2FA steps, then redirects to a disabled-account page — the app now detects that redirect and marks the account as Disabled rather than treating it as a successful login." },
    ],
  },
  {
    version: "1.0.279",
    date: "13 May 2026",
    items: [
      { category: "Verify Account", text: "Fixed: The 2FA code is now reliably typed and submitted. The Continue button was being clicked at the wrong position when it appeared below the visible area of the screen — it now scrolls into view before clicking, so the code is always actually submitted to Instagram." },
    ],
  },
  {
    version: "1.0.278",
    date: "13 May 2026",
    items: [
      { category: "Verify Account", text: "Fixed: Accounts with two-factor authentication (2FA) now verify correctly. The app was incorrectly reporting a successful 2FA login as rejected because Instagram's login page does not change its web address after you confirm a 2FA code — the app now detects success by checking the page content and session cookie instead." },
    ],
  },
  {
    version: "1.0.277",
    date: "13 May 2026",
    items: [
      { category: "Account Settings", text: "Removed the Cascade checkbox." },
      { category: "Account Settings", text: "Reset Device IDs is now on the same row as Verify Account, separated by a divider." },
      { category: "Embedded Browser", text: "Added Email Account and Email Password buttons to the toolbar. Clicking either one pastes the corresponding value from the Email Validation section of Account Settings into the focused field in the browser." },
      { category: "Embedded Browser", text: "Fill Credentials button renamed to Login." },
      { category: "Embedded Browser", text: "Add Phone Number button renamed to Phone Number." },
    ],
  },
  {
    version: "1.0.275",
    date: "13 May 2026",
    items: [
      { category: "Account Settings", text: "Fixed: The Group field now correctly works as both a dropdown and a text input — click the chevron or focus the field to see your existing groups as a list, and type freely to create a new one." },
    ],
  },
  {
    version: "1.0.274",
    date: "13 May 2026",
    items: [
      { category: "Accounts", text: "Added: Ctrl+C now removes the selected accounts from their group. Select the accounts you want to ungroup and press Ctrl+C — no menus needed." },
      { category: "Account Settings", text: "The Group field is now a free-text input. You can type any group name directly, or click the field to pick from your existing groups. Clear it to remove the account from its group." },
    ],
  },
  {
    version: "1.0.273",
    date: "13 May 2026",
    items: [
      { category: "Create an Account", text: "Fixed: Adding a new account no longer pre-fills a random username and the word 'password' — the username, password, and 2FA fields now start blank." },
      { category: "Account Settings", text: "Fixed: Editing the username or password no longer changes the account status to Logged Out. The status is now set to Pending instead, which is correct since the credentials have not been verified yet." },
      { category: "Account Settings", text: "Removed: The 'Saving…' and 'Saved' indicators no longer appear next to Account Name when editing any field. Changes still save automatically — the confirmation message is just gone." },
    ],
  },
  {
    version: "1.0.272",
    date: "13 May 2026",
    items: [
      { category: "Accounts", text: "Account cards now show the first letter of the username as an avatar instead of a generic Instagram logo, making each account visually distinct at a glance." },
      { category: "UI", text: "Open Browser button moved from the Account Settings tab to the top navigation bar next to Dash, so it is accessible from any tool tab without switching tabs." },
      { category: "Human Sessions", text: "Fixed: View Timeline Feed was returning 0 posts. The mobile session check incorrectly required a session cookie that the proxy always strips — it now correctly uses the saved Bearer token instead." },
      { category: "Human Sessions", text: "Fixed: Like Timeline Posts was returning 0 likes. The like client was not restoring the Bearer token from saved device state, so every like request was sent without credentials and rejected." },
      { category: "Login", text: "Fixed: Re-verifying an account that had already been verified once would always fail with no valid session. The verify flow now correctly detects the saved Bearer token as an active session and validates it directly instead of requiring a session cookie that the proxy strips." },
      { category: "Sidebar", text: "All five navigation icons (Dashboard, Accounts, Create an Account, Statistics, Proxy Manager) now use the same cyan-blue as the Equinox logo." },
      { category: "Sidebar", text: "Create an Account icon changed from a magic wand to a circle-plus, which more clearly conveys creating a new item." },
    ],
  },
  {
    version: "1.0.271",
    date: "13 May 2026",
    items: [
      { category: "Login", text: "No changes — version bump to trigger build." },
    ],
  },
  {
    version: "1.0.270",
    date: "13 May 2026",
    items: [
      { category: "Login", text: "Fixed account locking during API verification — the login request now sends plain fields instead of a signed wrapper, matching how the current Instagram app actually works." },
      { category: "Login", text: "Fixed incorrect password error — reverted an encryption change that was causing Instagram to reject valid passwords." },
      { category: "Login", text: "Added a guard that blocks re-verifying an account that is already awaiting email confirmation, preventing repeated attempts from compounding the issue." },
    ],
  },
  {
    version: "1.0.269",
    date: "13 May 2026",
    items: [
      { category: "Login", text: "Improved login reliability by aligning the pre-login call sequence exactly with known working patterns, including the correct call order and an additional header-fetch step before logging in." },
    ],
  },
  {
    version: "1.0.268",
    date: "13 May 2026",
    items: [
      { category: "Accounts", text: "Fixed: Toggling an imported account back on no longer sets it to Valid. The toggle now restores whatever status the account had before it was stopped — so a Pending account stays Pending when re-enabled." },
    ],
  },
  {
    version: "1.0.267",
    date: "13 May 2026",
    items: [
      { category: "Accounts", text: "Fixed: Importing an account (via CSV or EQX file) no longer instantly sets the status to Valid. All imported accounts now start as Pending so you can verify them before they run." },
      { category: "Accounts", text: "Fixed: All tools are now toggled off by default when importing an account from an EQX file. Previously the saved enabled state was restored, which could cause tools to start running immediately on import." },
    ],
  },
  {
    version: "1.0.266",
    date: "13 May 2026",
    items: [
      { category: "Statistics", text: "Fixed: Story Views column was always showing 0. The Timeline Stories engine block was watching and logging stories correctly but never calling incrementStat — the counter is now incremented for each story successfully watched, so the daily and lifetime totals update as expected." },
      { category: "Proxy Manager", text: "Fixed: Max per proxy split value now persists across page changes. The number you enter is saved to browser storage and restored when you return to the page instead of resetting to the default of 5." },
      { category: "Login", text: "Fixed: The Fill Credentials button no longer turns red for technical post-login failures (screenshot timeout, session capture errors, network blips). It only goes red when Instagram itself rejects the login — wrong password, checkpoint, 2FA challenge, banned account, etc." },
      { category: "Upload", text: "Fixed: The Upload button in the Embedded Browser now opens your file browser immediately. The intermediate 'File Upload Requested' confirmation dialog no longer appears — clicking Upload goes straight to the OS file picker." },
      { category: "2FA Code", text: "Fixed: The 2FA Code button now copies the generated TOTP code to clipboard AND automatically types it into the focused field in the browser — no manual paste needed." },
      { category: "UI", text: "Fixed: Dead white space above Account Name label is gone. The auto-save status bar is now only rendered when it has visible content (saving in progress, or creator mode active)." },
      { category: "Human Sessions", text: "Removed: 'Check Reels from Timeline' tool has been removed. View Timeline Feed already fetches the home feed which includes reels, and Like Timeline handles liking them at the configured percentage. No separate reels-only tool is needed." },
      { category: "Sidebar", text: "Accounts icon is now cyan, Statistics icon is red, Proxy Manager shield is green, Create an Account wand is black." },
      { category: "Dashboard", text: "Activity Log lightning bolt icon is now yellow. What's New bell icon is now red." },
    ],
  },
  {
    version: "1.0.265",
    date: "13 May 2026",
    items: [
      { category: "Watch Reels", text: "Fixed: Watch Reels was returning 'mobile session check passed but POST returned null' for many accounts. The clips/home endpoint now uses a GET request (the correct method for feed endpoints) with a fallback to the home timeline filtered for reels — so Watch Reels works regardless of which endpoint Instagram accepts for the account." },
      { category: "Like Timeline", text: "Fixed: Accounts whose home feed is dominated by Reels were getting 0 likes because reels were being watched but never liked. Reels are now liked after being watched, matching real user behaviour." },
      { category: "Session Handling", text: "Fixed: When Instagram rejects a mobile API call (returns an error page instead of JSON), the account's session is now immediately flagged as expired. The next tool cycle will surface a clear message to re-run Verify Credentials instead of the confusing 'POST returned null despite session check passing'." },
    ],
  },
  {
    version: "1.0.264",
    date: "12 May 2026",
    items: [
      { category: "Logs", text: "Session logs are now preserved across restarts. The previous 3 sessions are saved as logs.1.log, logs.2.log, logs.3.log in the same folder — useful for diagnosing login issues that happened before a restart." },
    ],
  },
  {
    version: "1.0.263",
    date: "13 May 2026, 07:30",
    items: [
      { category: "Watch Reels", text: "Fixed: Instagram deprecated the /api/v1/clips/feed/ endpoint (now returns 404 for all accounts). Watch Reels now uses /api/v1/clips/home/ — the current replacement endpoint — so reels watching resumes automatically without needing to re-run Verify Credentials." },
    ],
  },
  {
    version: "1.0.323",
    date: "15 May 2026",
    items: [
      { category: "Embedded Browser", text: "Fixed: Embedded browser sessions now survive app restarts and updates. Cookie files are stored in the same stable user data folder as the database, so logging in once is permanent — no more being logged out after installing a new version." },
    ],
  },
  {
    version: "1.0.322",
    date: "15 May 2026",
    items: [
      { category: "UI", text: "The Copy Settings link in the page header now only appears when you are on the Account Settings tab. It is hidden on all other tabs since each tool has its own Copy Settings button." },
      { category: "Follow Tool", text: "Stop Tool if Blocked for X minutes is now included as a copy setting in the Follow Tool." },
      { category: "Unfollow Tool", text: "Stop Tool if Blocked for X minutes is now included as a copy setting in the Unfollow Tool." },
      { category: "Contact Tool", text: "Stop Tool if Blocked for X minutes is now included as a copy setting in the Contact Tool." },
      { category: "Human Sessions", text: "Check Stories from Timeline and Check Direct Messages now each appear in their own separate settings box instead of being combined into one." },
      { category: "Hashtag Scraping", text: "Fixed: Multiple accounts scraping the same hashtag no longer see the same users. Scraped users are now always tracked and filtered out at the point of scraping — independent of any global setting — so each account picks up fresh users when it runs." },
    ],
  },
  {
    version: "1.0.262",
    date: "13 May 2026, 04:00",
    items: [
      { category: "Account Settings", text: "Fixed: White space no longer appears above the Account Name label when any field is edited. The auto-save status bar now always occupies its fixed height so the layout never shifts." },
      { category: "Account Settings", text: "Fixed: Removed the static dead white space block caused by unoverridden CardContent/CardHeader bottom padding (pb-6) leaking through transparent cards in the settings tab." },
      { category: "EQX Export", text: "Fixed: Exporting multiple accounts now opens exactly ONE save dialog. All selected accounts are bundled into a single equinox-accounts.zip archive instead of triggering one browser download dialog per file." },
      { category: "EQX Export", text: "Fixed: The assigned proxy IP address is now included in exported EQX files. When an account uses a Proxy Manager proxy (proxyId), the resolved host, port, username, and password are written to resolvedProxyHost/Port/Username/Password fields in the export." },
      { category: "Instagram Login", text: "Fixed: BLOKS_VERSION_ID is now overridden to the v378 value alongside APP_VERSION. The library's stale v222 default was causing Instagram to detect a fingerprint mismatch and reject the handshake." },
    ],
  },
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
  useScrollRestore("dashboard");
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
  const { openWindow } = useBrowserWindows();
  const [colWidths, setColWidths] = usePersistentSetting(
    "dashboard_col_widths_px",
    DEFAULT_COL_WIDTHS,
    (s, d) => ({ ...d, ...s }),
  );
  const [colOrder, setColOrder] = usePersistentSetting<(keyof typeof DEFAULT_COL_WIDTHS)[]>(
    "dashboard_col_order",
    DEFAULT_COL_ORDER,
    (s, d) => {
      const missing = d.filter(k => !s.includes(k));
      return missing.length ? [...s, ...missing] : s;
    },
  );
  const moveCol = (key: keyof typeof DEFAULT_COL_WIDTHS, dir: -1 | 1) => {
    const idx = colOrder.indexOf(key);
    const next = [...colOrder];
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= next.length) return;
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    setColOrder(next);
    localStorage.setItem("dashboard_col_order", JSON.stringify(next));
  };
  const dashDragColRef = useRef<string | null>(null);
  const [dashDragOverCol, setDashDragOverCol] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

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
  const [showOnlyErrors, setShowOnlyErrors] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const lastSessionIdRef = useRef<number>(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logMaxRowsRef = useRef<number>(2000);
  const { data: globalSettings } = useQuery<{ logMaxRows?: number }>({ queryKey: ["/api/settings"] });
  useEffect(() => {
    if (globalSettings?.logMaxRows != null) logMaxRowsRef.current = globalSettings.logMaxRows;
  }, [globalSettings]);
  const [feedPage, setFeedPage] = useState(0);
  const [feedJumpOpen, setFeedJumpOpen] = useState(false);
  useEffect(() => { setFeedPage(0); setFeedJumpOpen(false); }, [apiLogSearch, selectedProfileId, showOnlyErrors, clearedAt]);

  const fetchFeed = useCallback(async (isInitial = false) => {
    try {
      const [sessionRes] = await Promise.all([
        fetch(`/api/all-session-actions?limit=${logMaxRowsRef.current}`),
      ]);
      const [sessionRows]: [any[]] = await Promise.all([
        sessionRes.ok ? sessionRes.json() : Promise.resolve([]),
      ]);

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
        const all = [...newSessionItems].sort((a, b) => b.ts - a.ts).slice(0, logMaxRowsRef.current);
        setFeedItems(all);
      } else {
        const incoming = [...newSessionItems];
        if (incoming.length > 0) {
          setFeedItems(prev => [...incoming, ...prev].sort((a, b) => b.ts - a.ts).slice(0, logMaxRowsRef.current));
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

  const profileLookup = useMemo(() => {
    const m = new Map<number, string>();
    (profiles ?? []).forEach(p => m.set(p.id, p.accountLabel || p.username));
    return m;
  }, [profiles]);

  const filteredFeed = useMemo(() => feedItems
    .filter((item) => clearedAt === 0 || item.ts > clearedAt)
    .filter((item) => {
      if (errorsCleared === 0 || item.ts > errorsCleared) return true;
      return !(item.kind === "session" && item.action && ERROR_ACTIONS.has(item.action));
    })
    .filter((item) => !showOnlyErrors || (item.kind === "session" && item.action && ERROR_ACTIONS.has(item.action)))
    .filter((item) => selectedProfileId == null || item.profileId === selectedProfileId)
    .filter((item) => {
      if (!apiLogSearch.trim()) return true;
      const q = apiLogSearch.toLowerCase();
      const label = (profileLookup.get(item.profileId) ?? item.profileLabel ?? `#${item.profileId}`).toLowerCase();
      return (
        label.includes(q) ||
        (item.action ?? "").toLowerCase().includes(q) ||
        (item.targetUsername ?? "").toLowerCase().includes(q) ||
        (item.detail ?? "").toLowerCase().includes(q)
      );
    }), [feedItems, clearedAt, errorsCleared, showOnlyErrors, selectedProfileId, apiLogSearch, profileLookup]);

  const filteredProfileOptions = (profiles ?? []).filter(p =>
    !p.username.startsWith("__tpl_") && (
      !profileSearch.trim() ||
      p.username.toLowerCase().includes(profileSearch.toLowerCase())
    )
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

  const exportCsv = useCallback(() => {
    const headers = colOrder.map(k => COL_LABELS[k]);
    const rows = displayFeed.map(item => {
      if (item.kind === "import") {
        const imp = item.importData!;
        return colOrder.map(col => {
          if (col === "account") return "Import";
          if (col === "event") return "Profile Import";
          if (col === "target") return imp.fileName;
          if (col === "detail") return `${imp.created} created, ${imp.updated} updated, ${imp.failed} failed`;
          return format(new Date(imp.ts), "yyyy-MM-dd HH:mm:ss");
        });
      }
      const label = getUsername(item.profileId, item.profileLabel);
      return colOrder.map(col => {
        if (col === "account") return label;
        if (col === "event") {
          const style = ACTION_STYLES[item.action ?? ""];
          return style ? style.label : (item.action ?? "").replace(/_/g, " ");
        }
        if (col === "target") return item.targetUsername ? `@${item.targetUsername}` : "";
        if (col === "detail") return item.detail ?? "";
        return format(new Date(item.ts), "yyyy-MM-dd HH:mm:ss");
      });
    });
    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const csv = [headers.map(escape).join(","), ...rows.map(r => r.map(escape).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const ts = format(new Date(), "yyyy-MM-dd_HH-mm");
    const suffix = selectedProfileId != null ? `_${selectedProfile?.username ?? selectedProfileId}` : "";
    a.download = `equinox-activity${suffix}_${ts}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [displayFeed, colOrder, getUsername, selectedProfileId, selectedProfile]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setProfilePickerOpen(false);
        setProfileSearch("");
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
            Equinox started at: {format(new Date(serverInfo.startedAt), "MMM d yyyy HH:mm:ss")}
          </span>
        )}
      </div>

      <Card className="desktop-card border-none shadow-sm">
        <div className="flex items-center border-b border-border/50 px-4">
          <button className={tabClass("api-log")} onClick={() => setActiveTab("api-log")}>
            <Zap className="w-4 h-4 text-cyan-500" fill="currentColor" /> Activity Log
          </button>
          <button className={tabClass("whats-new")} onClick={() => setActiveTab("whats-new")}>
            <Bell className="w-4 h-4 text-cyan-500" fill="currentColor" /> What's New
          </button>
          <div className="ml-auto flex items-center gap-1">
            {activeTab === "api-log" && (
              <div>
                <button
                  onClick={() => setManageColsOpen(o => !o)}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-2.5 px-2"
                >
                  <Settings2 className="w-3.5 h-3.5" /> Manage Columns
                </button>
                {manageColsOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setManageColsOpen(false)} />
                    <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-background border border-border rounded-lg shadow-2xl w-[480px] max-h-[80vh] overflow-y-auto">
                      <div className="px-5 pt-4 pb-3 border-b border-border">
                        <p className="text-sm font-semibold">Columns</p>
                      </div>
                      <div className="p-4 grid grid-cols-2 gap-x-4 gap-y-1">
                        {colOrder.map((key, idx) => {
                          const label = COL_LABELS[key];
                          const updateCol = (delta: number) => {
                            const v = Math.max(1, Math.min(600, colWidths[key] + delta));
                            const next = { ...colWidths, [key]: v };
                            setColWidths(next);
                            localStorage.setItem("dashboard_col_widths_px", JSON.stringify(next));
                          };
                          return (
                            <div key={key} className="flex items-center gap-1 mb-1">
                              <div className="flex flex-col mr-0.5">
                                <button
                                  onClick={() => moveCol(key, -1)}
                                  disabled={idx === 0}
                                  className="h-4 w-4 flex items-center justify-center rounded hover:bg-muted/40 text-muted-foreground disabled:opacity-20 transition-colors"
                                >
                                  <ChevronUp className="w-2.5 h-2.5" />
                                </button>
                                <button
                                  onClick={() => moveCol(key, 1)}
                                  disabled={idx === colOrder.length - 1}
                                  className="h-4 w-4 flex items-center justify-center rounded hover:bg-muted/40 text-muted-foreground disabled:opacity-20 transition-colors"
                                >
                                  <ChevronDown className="w-2.5 h-2.5" />
                                </button>
                              </div>
                              <label className="text-xs w-16 text-muted-foreground shrink-0 truncate" title={label}>{label}</label>
                              <button
                                onClick={() => updateCol(-10)}
                                className="h-6 w-6 flex items-center justify-center border border-border rounded bg-background hover:bg-muted/40 text-muted-foreground transition-colors shrink-0"
                              >
                                <ChevronDown className="w-3 h-3" />
                              </button>
                              <input
                                type="number"
                                min={1}
                                max={600}
                                value={colWidths[key]}
                                onChange={e => {
                                  const v = Math.max(1, Math.min(600, Number(e.target.value)));
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
                      </div>
                      <div className="px-4 pb-4">
                        <button
                          onClick={() => { setColWidths(DEFAULT_COL_WIDTHS); localStorage.removeItem("dashboard_col_widths_px"); setColOrder(DEFAULT_COL_ORDER); localStorage.removeItem("dashboard_col_order"); }}
                          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                          Reset to defaults
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
            <button
              onClick={() => setShowOnlyErrors(v => !v)}
              className={`text-xs transition-colors py-2.5 px-2 ${showOnlyErrors ? "text-destructive font-medium" : "text-muted-foreground hover:text-destructive"}`}
            >
              {showOnlyErrors ? "Show all" : "Show only errors"}
            </button>
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
              className="text-xs bg-transparent outline-none text-foreground placeholder:text-muted-foreground w-80"
            />
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {activeTab === "api-log" ? (
            <div className="overflow-y-auto overflow-x-hidden max-h-[70vh]">
              <table className="w-full text-sm text-left table-fixed">
                <colgroup>
                  {colOrder.map(key => <col key={key} style={{ width: `${colWidths[key]}px` }} />)}
                </colgroup>
                <thead className="text-xs uppercase bg-muted/80 text-muted-foreground font-bold border-b border-border/50 sticky top-0 z-10 backdrop-blur-sm">
                  <tr>
                    {colOrder.map(key => {
                      const isDragTarget = dashDragOverCol === key;
                      return (
                        <th
                          key={key}
                          draggable
                          onDragStart={e => { dashDragColRef.current = key; e.dataTransfer.effectAllowed = "move"; }}
                          onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dashDragColRef.current && dashDragColRef.current !== key) setDashDragOverCol(key); }}
                          onDrop={e => {
                            e.preventDefault();
                            const from = dashDragColRef.current;
                            dashDragColRef.current = null;
                            setDashDragOverCol(null);
                            if (!from || from === key) return;
                            const fromIdx = colOrder.indexOf(from as keyof typeof DEFAULT_COL_WIDTHS);
                            const toIdx = colOrder.indexOf(key);
                            if (fromIdx === -1 || toIdx === -1) return;
                            const next = [...colOrder];
                            next.splice(fromIdx, 1);
                            next.splice(toIdx, 0, from as keyof typeof DEFAULT_COL_WIDTHS);
                            setColOrder(next);
                            localStorage.setItem("dashboard_col_order", JSON.stringify(next));
                          }}
                          onDragEnd={() => { dashDragColRef.current = null; setDashDragOverCol(null); }}
                          className={`px-3 py-4 font-bold cursor-default select-none ${isDragTarget ? "bg-primary/5 border-l-2 border-l-primary" : ""} ${(key === "trustscore" || key === "event" || key === "target" || key === "open_eb") ? "text-center" : ""}`}
                        >
                          {COL_LABELS[key]}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {initialLoading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <tr key={i} className="animate-pulse">
                        <td colSpan={colOrder.length} className="px-3 py-4 bg-muted/10 h-12" />
                      </tr>
                    ))
                  ) : filteredFeed.length === 0 ? (
                    <tr>
                      <td colSpan={colOrder.length} className="px-3 py-12 text-center text-muted-foreground">
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
                    displayFeed.slice(feedPage * 100, (feedPage + 1) * 100).map((item) => {
                      const label = getUsername(item.profileId, item.profileLabel);

                      const getCell = (col: keyof typeof DEFAULT_COL_WIDTHS) => {
                        if (col === "open_eb") return <td key={col} className="px-3 py-1.5 text-center">{item.profileId ? <button onClick={() => { const p = profiles?.find((pr: any) => pr.id === item.profileId); if (p) openWindow(p.id, p.username ?? "", p.userAgentEmbedded ?? ""); }} className="inline-flex items-center gap-1 text-xs text-cyan-500 hover:text-cyan-400 transition-colors font-medium whitespace-nowrap"><Monitor className="w-3.5 h-3.5 shrink-0" /><span>Open EB</span></button> : <span className="text-muted-foreground text-xs">—</span>}</td>;
                        if (col === "trustscore") return <td key={col} className="px-3 py-1.5"><div className="flex justify-center">{item.profileId ? <TrustScoreBadge profileId={item.profileId} /> : <span className="text-muted-foreground text-xs">—</span>}</div></td>;
                        if (item.kind === "import") {
                          const imp = item.importData!;
                          if (col === "account") return <td key={col} className="px-3 py-3 font-medium truncate"><span className="flex items-center gap-1.5 text-foreground min-w-0"><Upload className="w-3.5 h-3.5 text-blue-500 shrink-0" /><span className="truncate text-xs font-semibold">Import</span></span></td>;
                          if (col === "event") return <td key={col} className="px-3 py-3 truncate text-center"><span className="px-2 py-0.5 rounded bg-blue-100 text-blue-700 text-[10px] font-bold uppercase tracking-wider">Profile Import</span></td>;
                          if (col === "target") return <td key={col} className="px-3 py-3 text-xs text-muted-foreground truncate text-center" title={imp.fileName}>{imp.fileName}</td>;
                          if (col === "detail") return <td key={col} className="px-3 py-3 text-xs truncate"><span className="flex items-center gap-2">{imp.created > 0 && <span className="font-semibold text-emerald-600">{imp.created} created</span>}{imp.updated > 0 && <span className="font-semibold text-blue-600">{imp.updated} updated</span>}{imp.failed > 0 && <span className="font-semibold text-destructive">{imp.failed} failed</span>}</span></td>;
                          return <td key={col} className="px-3 py-3 text-muted-foreground text-xs font-mono truncate"><span className="flex items-center gap-1 min-w-0"><Clock className="w-3 h-3 shrink-0" /><span className="truncate">{format(new Date(imp.ts), "MMM d yyyy, HH:mm:ss")}</span><button onClick={() => { localStorage.setItem("equinox_import_dismissed", String(imp.ts)); setImportDismissed(imp.ts); }} className="ml-auto text-muted-foreground hover:text-foreground transition-colors shrink-0" title="Dismiss"><X className="w-3 h-3" /></button></span></td>;
                        }
                        const style = ACTION_STYLES[item.action ?? ""] ?? { label: (item.action ?? "event").replace(/_/g, " "), cls: "text-muted-foreground", icon: "·" };
                        if (col === "account") return <td key={col} className="px-3 py-3 font-medium truncate"><Link href={`/profiles/${item.profileId}?tab=human-session`} className="flex items-center gap-1.5 text-foreground hover:text-primary transition-colors group min-w-0"><User className="w-3.5 h-3.5 text-primary shrink-0" /><span className="group-hover:underline underline-offset-2 truncate">{label}</span></Link></td>;
                        if (col === "event") return <td key={col} className="px-3 py-3 truncate text-center"><span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider truncate inline-flex items-center gap-1 max-w-full ${style.cls}`}><span>{style.label}</span><span className="shrink-0 leading-none">{style.icon}</span></span></td>;
                        if (col === "target") return <td key={col} className="px-3 py-3 text-xs text-foreground/80 truncate text-center" title={item.targetUsername || undefined}>{item.targetUsername ? `@${item.targetUsername}` : " "}</td>;
                        if (col === "detail") return <td key={col} className="px-3 py-3 text-foreground truncate text-xs" title={item.detail || undefined}>{item.detail || " "}</td>;
                        return <td key={col} className="px-3 py-3 text-muted-foreground text-xs font-mono truncate"><span className="flex items-center gap-1 min-w-0"><Clock className="w-3 h-3 shrink-0" /><span className="truncate">{format(new Date(item.ts), "MMM d yyyy, HH:mm:ss")}</span></span></td>;
                      };

                      const rowCls = item.kind === "import"
                        ? "bg-blue-50/60 hover:bg-blue-50/80 transition-colors"
                        : "hover:bg-accent/5 transition-colors";
                      return (
                        <tr key={item.key} className={rowCls}>
                          {colOrder.map(col => getCell(col))}
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

        {activeTab === "api-log" && (
          <div className="flex items-center justify-between px-4 py-2 border-t border-border/40 bg-muted/20 rounded-b-xl">
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground tabular-nums">
                {displayFeed.length === 0
                  ? "No rows"
                  : `${(feedPage * 100 + 1).toLocaleString()}–${Math.min((feedPage + 1) * 100, displayFeed.length).toLocaleString()} of ${displayFeed.length.toLocaleString()}${(apiLogSearch.trim() || selectedProfileId != null) ? " (filtered)" : ""}`}
              </span>
              {(() => {
                const totalFeedPages = Math.max(1, Math.ceil(displayFeed.length / 100));
                return (
                  <div className="flex items-center gap-0.5">
                    <button
                      onClick={() => setFeedPage(p => Math.max(0, p - 1))}
                      disabled={feedPage === 0 || displayFeed.length === 0}
                      className="p-1 rounded hover:bg-accent/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Previous page"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </button>
                    <div className="relative">
                      <button
                        onClick={() => setFeedJumpOpen(v => !v)}
                        disabled={displayFeed.length === 0}
                        className="flex items-center gap-0.5 text-xs text-muted-foreground tabular-nums px-1 py-0.5 rounded hover:bg-accent/30 hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        title="Jump to page"
                      >
                        {displayFeed.length === 0 ? "—" : feedPage === 0 ? "First" : feedPage === totalFeedPages - 1 ? "Last" : feedPage + 1}
                        <ChevronDown className="w-3 h-3 opacity-60" />
                      </button>
                      {feedJumpOpen && displayFeed.length > 0 && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setFeedJumpOpen(false)} />
                          <div className="absolute bottom-full mb-1 right-0 z-50 bg-popover border border-border rounded shadow-md overflow-y-auto min-w-[10rem]" style={{ maxHeight: "6rem" }}>
                            {Array.from({ length: totalFeedPages }, (_, i) => (
                              <button
                                key={i}
                                onClick={() => { setFeedPage(i); setFeedJumpOpen(false); }}
                                className={`block w-full text-left px-3 py-1.5 text-xs whitespace-nowrap hover:bg-accent/30 transition-colors ${feedPage === i ? "font-semibold text-primary" : "text-foreground"}`}
                              >
                                {i === 0 ? "First (most recent)" : i === totalFeedPages - 1 ? "Last (oldest)" : i + 1}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                    <button
                      onClick={() => setFeedPage(p => Math.min(Math.max(0, Math.ceil(displayFeed.length / 100) - 1), p + 1))}
                      disabled={feedPage >= Math.ceil(displayFeed.length / 100) - 1 || displayFeed.length === 0}
                      className="p-1 rounded hover:bg-accent/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Next page"
                    >
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })()}
            </div>
            <button
              onClick={exportCsv}
              disabled={displayFeed.length === 0}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-accent/30 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </button>
          </div>
        )}
      </Card>
    </AppLayout>
  );
}
