import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { usePersistentSetting } from "@/hooks/use-persistent-setting";
import { useScrollRestore } from "@/hooks/useScrollRestore";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Activity, Clock, User, Zap, Sparkles, Bell, Search, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, X, RefreshCw, Settings2, Upload, Download,
  Users, UserCheck, ImageIcon, CheckCircle2,
} from "lucide-react";
import { TrustScoreBadge, getTrustScore, getTrustLevels } from "@/components/TrustScoreBadge";
import { format } from "date-fns";
import { type Profile } from "@shared/schema";

type Tab = "api-log" | "whats-new";

const ERROR_ACTIONS = new Set([
  "verification_failed", "follow_blocked", "unfollow_blocked",
  "dm_blocked", "contact_dm_blocked", "logged_out",
]);

const ACTION_STYLES: Record<string, { label: string; cls: string; icon: string }> = {
  tool_start:              { label: "Started",         cls: "text-blue-700",      icon: "▶" },
  tool_complete:           { label: "Complete",        cls: "text-emerald-700",   icon: "✓" },
  verified:                { label: "Verified",        cls: "text-green-700",     icon: "✓" },
  verification_failed:     { label: "Verify Fail",     cls: "text-red-700",       icon: "✗" },
  follow:                  { label: "Follow",          cls: "text-sky-700",       icon: "+" },
  follow_blocked:          { label: "Blocked",         cls: "text-rose-700",      icon: "⊘" },
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
  like_timeline_post:      { label: "Timeline Like",   cls: "text-rose-600",      icon: "♥" },
  check_timeline_reels:    { label: "Watch Reels",     cls: "text-orange-700",    icon: "▶" },
  check_timeline_stories:  { label: "Watch Stories",   cls: "text-amber-700",     icon: "◎" },
  visit_notifications:     { label: "Notifications",   cls: "text-sky-600",       icon: "🔔" },
  visit_own_profile:       { label: "Own Profile",     cls: "text-indigo-600",    icon: "◉" },
  refresh_own_profile:     { label: "Refresh Profile", cls: "text-indigo-600",    icon: "↺" },
  visit_settings_activity: { label: "Settings",        cls: "text-slate-600",     icon: "⚙" },
  save_media:              { label: "Save Media",      cls: "text-emerald-600",   icon: "⊙" },
};

const DEFAULT_COL_WIDTHS = { account: 160, event: 150, target: 100, detail: 200, timestamp: 220, trustscore: 120 };
const DEFAULT_COL_ORDER: (keyof typeof DEFAULT_COL_WIDTHS)[] = ["account", "trustscore", "event", "target", "detail", "timestamp"];
const COL_LABELS: Record<keyof typeof DEFAULT_COL_WIDTHS, string> = {
  account: "ACCOUNT", event: "ACTION", target: "TARGET", detail: "DETAIL", timestamp: "TIMESTAMP", trustscore: "TRUSTSCORE",
};

const CHANGELOG: { version: string; date: string; items: { category: string; text: string }[] }[] = [
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
  const [showOnlyErrors, setShowOnlyErrors] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const lastApiIdRef = useRef<number>(0);
  const lastSessionIdRef = useRef<number>(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logMaxRowsRef = useRef<number>(2000);
  const { data: globalSettings } = useQuery<{ logMaxRows?: number }>({ queryKey: ["/api/settings"] });
  useEffect(() => {
    if (globalSettings?.logMaxRows != null) logMaxRowsRef.current = globalSettings.logMaxRows;
  }, [globalSettings]);
  const [feedPage, setFeedPage] = useState(0);
  useEffect(() => { setFeedPage(0); }, [apiLogSearch, selectedProfileId, showOnlyErrors, clearedAt]);

  const fetchFeed = useCallback(async (isInitial = false) => {
    try {
      const [apiRes, sessionRes] = await Promise.all([
        fetch(lastApiIdRef.current > 0
          ? `/api/instagram-api-calls?since=${lastApiIdRef.current}`
          : "/api/instagram-api-calls?limit=2000"),
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
        const all = [...newApiRows, ...newSessionItems].sort((a, b) => b.ts - a.ts).slice(0, logMaxRowsRef.current);
        setFeedItems(all);
      } else {
        const incoming = [...newApiRows, ...newSessionItems];
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
          if (item.kind === "api") return (item.operationName ?? "").replace(/_/g, " ");
          const style = ACTION_STYLES[item.action ?? ""];
          return style ? style.label : (item.action ?? "").replace(/_/g, " ");
        }
        if (col === "target") return item.targetUsername ? `@${item.targetUsername}` : "";
        if (col === "detail") return item.kind === "api" ? (item.message ?? "") : (item.detail ?? "");
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
            Equinox started {format(new Date(serverInfo.startedAt), "MMM d yyyy 'at' HH:mm:ss")}
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
              <div ref={manageColsRef} className="relative">
                <button
                  onClick={() => setManageColsOpen(o => !o)}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-2.5 px-2"
                >
                  <Settings2 className="w-3.5 h-3.5" /> Manage Columns
                </button>
                {manageColsOpen && (
                  <div className="absolute right-0 top-full mt-1 z-50 bg-background border border-border rounded-lg shadow-xl p-4 w-64">
                    <p className="text-[11px] font-bold uppercase tracking-wide mb-3 text-muted-foreground">Column Widths (px)</p>
                    {colOrder.map((key, idx) => {
                      const label = COL_LABELS[key];
                      const updateCol = (delta: number) => {
                        const v = Math.max(40, Math.min(600, colWidths[key] + delta));
                        const next = { ...colWidths, [key]: v };
                        setColWidths(next);
                        localStorage.setItem("dashboard_col_widths_px", JSON.stringify(next));
                      };
                      return (
                        <div key={key} className="flex items-center gap-1 mb-2">
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
                      onClick={() => { setColWidths(DEFAULT_COL_WIDTHS); localStorage.removeItem("dashboard_col_widths_px"); setColOrder(DEFAULT_COL_ORDER); localStorage.removeItem("dashboard_col_order"); }}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors mt-1"
                    >
                      Reset to defaults
                    </button>
                  </div>
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
              className="text-xs bg-transparent outline-none text-foreground placeholder:text-muted-foreground w-64"
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
                          className={`px-3 py-4 font-bold cursor-default select-none ${isDragTarget ? "bg-primary/5 border-l-2 border-l-primary" : ""}`}
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
                    displayFeed.slice(feedPage * 50, (feedPage + 1) * 50).map((item) => {
                      const label = getUsername(item.profileId, item.profileLabel);

                      const getCell = (col: keyof typeof DEFAULT_COL_WIDTHS) => {
                        if (col === "trustscore") return <td key={col} className="px-3 py-1.5"><div className="flex justify-center">{item.profileId ? <TrustScoreBadge profileId={item.profileId} /> : <span className="text-muted-foreground text-xs">—</span>}</div></td>;
                        if (item.kind === "import") {
                          const imp = item.importData!;
                          if (col === "account") return <td key={col} className="px-3 py-3 font-medium truncate"><span className="flex items-center gap-1.5 text-foreground min-w-0"><Upload className="w-3.5 h-3.5 text-blue-500 shrink-0" /><span className="truncate text-xs font-semibold">Import</span></span></td>;
                          if (col === "event") return <td key={col} className="px-3 py-3 truncate"><span className="px-2 py-0.5 rounded bg-blue-100 text-blue-700 text-[10px] font-bold uppercase tracking-wider">Profile Import</span></td>;
                          if (col === "target") return <td key={col} className="px-3 py-3 text-xs text-muted-foreground truncate" title={imp.fileName}>{imp.fileName}</td>;
                          if (col === "detail") return <td key={col} className="px-3 py-3 text-xs truncate"><span className="flex items-center gap-2">{imp.created > 0 && <span className="font-semibold text-emerald-600">{imp.created} created</span>}{imp.updated > 0 && <span className="font-semibold text-blue-600">{imp.updated} updated</span>}{imp.failed > 0 && <span className="font-semibold text-destructive">{imp.failed} failed</span>}</span></td>;
                          return <td key={col} className="px-3 py-3 text-muted-foreground text-xs font-mono truncate"><span className="flex items-center gap-1 min-w-0"><Clock className="w-3 h-3 shrink-0" /><span className="truncate">{format(new Date(imp.ts), "MMM d yyyy, HH:mm:ss")}</span><button onClick={() => { localStorage.setItem("equinox_import_dismissed", String(imp.ts)); setImportDismissed(imp.ts); }} className="ml-auto text-muted-foreground hover:text-foreground transition-colors shrink-0" title="Dismiss"><X className="w-3 h-3" /></button></span></td>;
                        }
                        if (item.kind === "api") {
                          if (col === "account") return <td key={col} className="px-3 py-3 font-medium truncate"><Link href={`/profiles/${item.profileId}?tab=follow`} className="flex items-center gap-1.5 text-foreground hover:text-primary transition-colors group min-w-0"><User className="w-3.5 h-3.5 text-primary shrink-0" /><span className="group-hover:underline underline-offset-2 truncate">{label}</span></Link></td>;
                          if (col === "event") return <td key={col} className="px-3 py-3 truncate"><span className="px-2 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-bold uppercase tracking-wider truncate inline-block max-w-full">{(item.operationName ?? "").replace(/_/g, " ")}</span></td>;
                          if (col === "target") return <td key={col} className="px-3 py-3 text-xs text-muted-foreground truncate"> </td>;
                          if (col === "detail") {
                            const msg = item.message || "";
                            const syncMatch = msg.match(/^followers=(\d+)\s+following=(\d+)\s+posts=(\d+)\s+Synced$/);
                            if (syncMatch) {
                              return (
                                <td key={col} className="px-3 py-3 truncate">
                                  <span className="flex items-center gap-3 text-xs">
                                    <span className="flex items-center gap-1 text-muted-foreground"><Users className="w-3 h-3 text-primary/70" />{syncMatch[1]}</span>
                                    <span className="flex items-center gap-1 text-muted-foreground"><UserCheck className="w-3 h-3 text-primary/70" />{syncMatch[2]}</span>
                                    <span className="flex items-center gap-1 text-muted-foreground"><ImageIcon className="w-3 h-3 text-primary/70" />{syncMatch[3]}</span>
                                    <span className="flex items-center gap-1 text-emerald-500 font-medium"><CheckCircle2 className="w-3 h-3" />Synced</span>
                                  </span>
                                </td>
                              );
                            }
                            return <td key={col} className="px-3 py-3 text-foreground truncate text-xs" title={msg || undefined}>{msg || " "}</td>;
                          }
                          return <td key={col} className="px-3 py-3 text-muted-foreground text-xs font-mono truncate"><span className="flex items-center gap-1 min-w-0"><Clock className="w-3 h-3 shrink-0" /><span className="truncate">{format(new Date(item.ts), "MMM d yyyy, HH:mm:ss")}</span></span></td>;
                        }
                        const style = ACTION_STYLES[item.action ?? ""] ?? { label: (item.action ?? "event").replace(/_/g, " "), cls: "text-muted-foreground", icon: "·" };
                        if (col === "account") return <td key={col} className="px-3 py-3 font-medium truncate"><Link href={`/profiles/${item.profileId}?tab=follow`} className="flex items-center gap-1.5 text-foreground hover:text-primary transition-colors group min-w-0"><User className="w-3.5 h-3.5 text-primary shrink-0" /><span className="group-hover:underline underline-offset-2 truncate">{label}</span></Link></td>;
                        if (col === "event") return <td key={col} className="px-3 py-3 truncate"><span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider truncate inline-flex items-center gap-1 max-w-full ${style.cls}`}><span>{style.label}</span><span className="shrink-0 leading-none">{style.icon}</span></span></td>;
                        if (col === "target") return <td key={col} className="px-3 py-3 text-xs text-foreground/80 truncate" title={item.targetUsername || undefined}>{item.targetUsername ? `@${item.targetUsername}` : " "}</td>;
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
                  : `${(feedPage * 50 + 1).toLocaleString()}–${Math.min((feedPage + 1) * 50, displayFeed.length).toLocaleString()} of ${displayFeed.length.toLocaleString()}${(apiLogSearch.trim() || selectedProfileId != null) ? " (filtered)" : ""}`}
              </span>
              <div className="flex items-center gap-0.5">
                <button
                  onClick={() => setFeedPage(p => Math.max(0, p - 1))}
                  disabled={feedPage === 0 || displayFeed.length === 0}
                  className="p-1 rounded hover:bg-accent/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Previous page"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <span className="text-xs text-muted-foreground tabular-nums px-1">
                  {displayFeed.length === 0 ? "—" : `${feedPage + 1} / ${Math.max(1, Math.ceil(displayFeed.length / 50))}`}
                </span>
                <button
                  onClick={() => setFeedPage(p => Math.min(Math.max(0, Math.ceil(displayFeed.length / 50) - 1), p + 1))}
                  disabled={feedPage >= Math.ceil(displayFeed.length / 50) - 1 || displayFeed.length === 0}
                  className="p-1 rounded hover:bg-accent/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Next page"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
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
