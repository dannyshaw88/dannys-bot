import { useState, useRef, useEffect, useCallback } from "react";
import { useScrollRestore } from "@/hooks/useScrollRestore";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Activity, Clock, User, Zap, Sparkles, Bell, Search, ChevronDown, ChevronUp, X, RefreshCw, Settings2, Upload, Download,
} from "lucide-react";
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

const DEFAULT_COL_WIDTHS = { account: 160, event: 150, target: 100, detail: 200, timestamp: 220 };
const DEFAULT_COL_ORDER: (keyof typeof DEFAULT_COL_WIDTHS)[] = ["account", "event", "target", "detail", "timestamp"];
const COL_LABELS: Record<keyof typeof DEFAULT_COL_WIDTHS, string> = {
  account: "Account", event: "Action", target: "Target", detail: "Detail", timestamp: "Timestamp",
};

const CHANGELOG: { version: string; date: string; items: { category: string; text: string }[] }[] = [
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
  const [colWidths, setColWidths] = useState<typeof DEFAULT_COL_WIDTHS>(() => {
    try {
      const s = localStorage.getItem("dashboard_col_widths_px");
      return s ? { ...DEFAULT_COL_WIDTHS, ...JSON.parse(s) } : DEFAULT_COL_WIDTHS;
    } catch { return DEFAULT_COL_WIDTHS; }
  });
  const [colOrder, setColOrder] = useState<(keyof typeof DEFAULT_COL_WIDTHS)[]>(() => {
    try {
      const s = localStorage.getItem("dashboard_col_order");
      return s ? JSON.parse(s) : DEFAULT_COL_ORDER;
    } catch { return DEFAULT_COL_ORDER; }
  });
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
    .filter((item) => !showOnlyErrors || (item.kind === "session" && item.action && ERROR_ACTIONS.has(item.action)))
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
            <Zap className="w-4 h-4 text-cyan-500" /> Activity Log
          </button>
          <button className={tabClass("whats-new")} onClick={() => setActiveTab("whats-new")}>
            <Bell className="w-4 h-4 text-cyan-500" /> What's New
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
                          className={`px-3 py-4 font-bold cursor-grab active:cursor-grabbing select-none ${isDragTarget ? "bg-primary/5 border-l-2 border-l-primary" : ""}`}
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
                    displayFeed.map((item) => {
                      const label = getUsername(item.profileId, item.profileLabel);

                      const getCell = (col: keyof typeof DEFAULT_COL_WIDTHS) => {
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
                          if (col === "detail") return <td key={col} className="px-3 py-3 text-foreground truncate text-xs" title={item.message || undefined}>{item.message || " "}</td>;
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
            <span className="text-xs text-muted-foreground">
              {displayFeed.length.toLocaleString()} {displayFeed.length === 1 ? "row" : "rows"}
              {(apiLogSearch.trim() || selectedProfileId != null) ? " (filtered)" : ""}
            </span>
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
