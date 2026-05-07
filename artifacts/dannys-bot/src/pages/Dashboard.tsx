import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Activity, Clock, User, Zap, Sparkles, Bell, Search, ChevronDown, ChevronUp, X, RefreshCw, Settings2,
} from "lucide-react";
import { format } from "date-fns";
import { type Profile } from "@shared/schema";

type Tab = "api-log" | "whats-new";

const ERROR_ACTIONS = new Set([
  "verification_failed", "follow_blocked", "unfollow_blocked",
  "dm_blocked", "contact_dm_blocked",
]);

const ACTION_STYLES: Record<string, { label: string; cls: string }> = {
  tool_start:          { label: "Started",      cls: "bg-blue-100 text-blue-700" },
  tool_complete:       { label: "Complete",     cls: "bg-emerald-100 text-emerald-700" },
  verified:            { label: "Verified",     cls: "bg-emerald-100 text-emerald-700" },
  verification_failed: { label: "Verify Fail",  cls: "bg-red-100 text-red-700" },
  follow:              { label: "Follow",        cls: "bg-sky-100 text-sky-700" },
  follow_blocked:      { label: "Blocked",       cls: "bg-red-100 text-red-700" },
  follow_skipped:      { label: "Skipped",       cls: "bg-orange-100 text-orange-700" },
  dedup_skip:          { label: "Skipped",        cls: "bg-yellow-100 text-yellow-700" },
  filter_skip:         { label: "Skipped",        cls: "bg-yellow-100 text-yellow-700" },
  unfollow:            { label: "Unfollow",      cls: "bg-orange-100 text-orange-700" },
  unfollow_blocked:    { label: "UF Block",      cls: "bg-red-100 text-red-700" },
  dm:                  { label: "DM",            cls: "bg-purple-100 text-purple-700" },
  dm_blocked:          { label: "DM Block",      cls: "bg-red-100 text-red-700" },
  contact_dm_blocked:  { label: "DM Block",      cls: "bg-red-100 text-red-700" },
  no_sources:          { label: "No Sources",    cls: "bg-slate-100 text-slate-600" },
};

const DEFAULT_COL_WIDTHS = { account: 160, event: 150, target: 100, detail: 200, timestamp: 220 };

const CHANGELOG: { version: string; date: string; items: { category: string; text: string }[] }[] = [
  {
    version: "1.5.0",
    date: "6 May 2026, 22:10",
    items: [
      { category: "Dashboard", text: "What's New tab icon changed from star to bell." },
      { category: "Dashboard", text: "Changelog is permanently stored in the app — entries are never lost even if GitHub releases are deleted." },
      { category: "Dashboard", text: "Manage Columns now has ↑ ↓ step buttons (±10 px each click) alongside the pixel input." },
      { category: "Profiles", text: "Added Manage Columns button in the bottom bar next to Actions — control column widths on the Accounts page, saved across sessions." },
      { category: "Settings", text: "Added visual separator lines between each settings section for easier navigation." },
      { category: "Verify", text: "Fixed account lockouts: accounts with an existing mobile session (igApiCookies) now use session validation only — a fresh password login is never attempted on top of an active session." },
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
  kind: "api" | "session";
  operationName?: string;
  message?: string;
  profileLabel?: string;
  action?: string;
  targetUsername?: string;
  detail?: string;
};

export function Dashboard() {
  const [activeTab, setActiveTab] = useState<Tab>("api-log");
  const [changelogFilter, setChangelogFilter] = useState("");
  const [apiLogSearch, setApiLogSearch] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState<number | null>(null);
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

      // Operations already covered by a clean session_action entry — no need to
      // show the raw API log row as well (it would just be ugly duplicate noise).
      const HIDDEN_OPS = new Set(["getNewFollowersHikerAPI", "getNewFollowers", "v1/user/by/username"]);

      const newApiRows: FeedItem[] = apiRows
        // "Account" source = timed() calls from InstagramWebClient — already
        // surfaced as session_actions, so skip to avoid duplicate entries.
        // "Browser"/"Verify" = EB and login calls — never useful in the feed.
        // "HikerAPI" = scrape metadata — shown since it adds unique context.
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

  const getUsername = (profileId: number, label?: string) => {
    if (label) return label;
    const p = profiles?.find(p => Number(p.id) === Number(profileId));
    return p?.accountLabel || p?.username || `#${profileId}`;
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
                    filteredFeed.map((item) => {
                      const label = getUsername(item.profileId, item.profileLabel);
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
                            <td className="px-3 py-3 text-xs text-muted-foreground truncate">—</td>
                            <td className="px-3 py-3 text-foreground truncate text-xs" title={item.message || undefined}>
                              {item.message || "—"}
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
                      const style = ACTION_STYLES[item.action ?? ""] ?? { label: (item.action ?? "event").replace(/_/g, " "), cls: "bg-muted text-muted-foreground" };
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
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider truncate inline-block max-w-full ${style.cls}`}>
                              {style.label}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-xs text-foreground/80 truncate" title={item.targetUsername || undefined}>
                            {item.targetUsername ? `@${item.targetUsername}` : "—"}
                          </td>
                          <td className="px-3 py-3 text-foreground truncate text-xs" title={item.detail || undefined}>
                            {item.detail || "—"}
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
