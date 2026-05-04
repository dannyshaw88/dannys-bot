import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Activity, Clock, User, Zap, Sparkles, Search, ChevronDown, X, RefreshCw } from "lucide-react";
import { format } from "date-fns";
import { type Profile } from "@shared/schema";

type Tab = "api-log" | "whats-new";

const CHANGELOG: { version: string; date: string; items: { category: string; text: string }[] }[] = [
  {
    version: "1.2.0",
    date: "3 May 2026",
    items: [
      { category: "Human Sessions", text: "Added local folder as a repost source — pick a folder on your PC's hard drive, images are automatically deleted after upload." },
      { category: "Human Sessions", text: "Added Save Media percentage — controls what share of liked timeline posts get saved to your Instagram collection." },
      { category: "Profiles", text: "Added bulk Verify All Accounts action with configurable staggered delays between each account." },
      { category: "Profiles", text: "Added keyboard shortcuts: Ctrl+D Delete, Ctrl+P Remove Proxies, Ctrl+R Verify All, Ctrl+F Fix Captcha." },
      { category: "Profiles", text: "Added Fix Captcha action — automatically resolves captcha challenges using 2captcha.com." },
      { category: "Unfollow Tool", text: "Added custom target user list — enter usernames manually, import from a .txt/.csv file, or fetch followings via HikerAPI." },
      { category: "Auto Reply", text: "Added option to only reply to users the account already follows." },
      { category: "Auto Reply", text: "Added option to like the incoming DM before sending the auto-reply." },
      { category: "All Tools", text: "All active tools now display estimated items/hour and next scheduled execution time." },
      { category: "Dashboard", text: "Added What's New tab showing feature and fix history for each release." },
      { category: "Settings", text: "Added 2Captcha API key configuration for the Fix Captcha feature." },
      { category: "Settings", text: "Added Verify All Accounts delay — configurable min/max seconds between each account verification." },
    ],
  },
  {
    version: "1.1.0",
    date: "14 April 2026",
    items: [
      { category: "Repost", text: "Added image alteration pipeline with small / medium / high presets and manual per-filter overrides (contrast, brightness, noise, sharpen, pixelate)." },
      { category: "Repost", text: "Added HikerAPI feed scraping option so repost doesn't consume account session requests." },
      { category: "Repost", text: "Auto-disable repost when post count reaches a configurable target, or when all source posts have already been reposted." },
      { category: "Human Sessions", text: "Added Post Caption spintax support with placeholders: {original_caption}, {source_username}, {own_username}." },
      { category: "Unfollow Tool", text: "Added whitelist support — accounts on the whitelist are never unfollowed regardless of follow age." },
      { category: "Follow Tool", text: "Added source filtering by follower count, following count, and post count." },
      { category: "Contact Tool", text: "Added DM sending to new followers with configurable delay and message templates." },
      { category: "Proxy Manager", text: "Added proxy health-check with latency display and bulk import from CSV." },
    ],
  },
  {
    version: "1.0.0",
    date: "2 March 2026",
    items: [
      { category: "Core", text: "Initial release of Danny's Bot automation dashboard." },
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

export function Dashboard() {
  const [activeTab, setActiveTab] = useState<Tab>("api-log");
  const [changelogFilter, setChangelogFilter] = useState("");
  const [apiLogSearch, setApiLogSearch] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState<number | null>(null);
  const [profilePickerOpen, setProfilePickerOpen] = useState(false);
  const [profileSearch, setProfileSearch] = useState("");
  const pickerRef = useRef<HTMLDivElement>(null);

  // ── Real-time API call log (append-only, newest first) ──────────────────────
  const [apiCalls, setApiCalls] = useState<any[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const lastIdRef = useRef<number>(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchAndAppend = useCallback(async (since: number, isInitial = false) => {
    try {
      const url = since > 0
        ? `/api/instagram-api-calls?since=${since}`
        : "/api/instagram-api-calls";
      const res = await fetch(url);
      if (!res.ok) return;
      const rows: any[] = await res.json();
      if (rows.length > 0) {
        const filtered = rows.filter((c: any) => c.source !== "Browser" && c.source !== "Verify");
        const maxId = Math.max(...rows.map((r: any) => r.id));
        lastIdRef.current = Math.max(lastIdRef.current, maxId);
        if (isInitial) {
          setApiCalls(filtered);
        } else {
          setApiCalls(prev => [...filtered, ...prev]);
        }
      } else if (isInitial) {
        setApiCalls([]);
      }
    } catch { /* ignore */ } finally {
      if (isInitial) setInitialLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAndAppend(0, true);
    const schedule = () => {
      pollTimerRef.current = setTimeout(async () => {
        await fetchAndAppend(lastIdRef.current);
        schedule();
      }, 3000);
    };
    schedule();
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [fetchAndAppend]);

  // ── Server startup time ──────────────────────────────────────────────────────
  const { data: serverInfo } = useQuery<{ startedAt: string }>({
    queryKey: ["/api/server-info"],
  });

  const { data: profiles } = useQuery<Profile[]>({
    queryKey: ["/api/profiles"],
  });

  const getUsername = (profileId: number) =>
    profiles?.find(p => p.id === profileId)?.username || `ID: ${profileId}`;

  const selectedProfile = profiles?.find(p => p.id === selectedProfileId) ?? null;

  const filteredApiCalls = apiCalls
    .filter((c: any) => selectedProfileId == null || c.profileId === selectedProfileId)
    .filter((c: any) => {
      if (!apiLogSearch.trim()) return true;
      const q = apiLogSearch.toLowerCase();
      return (
        (c.operationName ?? "").toLowerCase().includes(q) ||
        (c.message ?? "").toLowerCase().includes(q) ||
        getUsername(c.profileId).toLowerCase().includes(q)
      );
    });

  const filteredProfileOptions = (profiles ?? []).filter(p =>
    !profileSearch.trim() ||
    p.username.toLowerCase().includes(profileSearch.toLowerCase())
  );

  // Close picker on outside click
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
      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Dashboard</h1>
        <div className="flex items-center gap-3 mt-1 flex-wrap">
          <p className="text-muted-foreground">Live view of all Instagram API calls made by the automation engine.</p>
          {serverInfo?.startedAt && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground/70 border border-border/40 rounded px-2 py-0.5 bg-muted/20">
              <RefreshCw className="w-3 h-3" />
              Server started {format(new Date(serverInfo.startedAt), "MMM d 'at' HH:mm:ss")}
            </span>
          )}
        </div>
      </div>

      <Card className="desktop-card border-none shadow-sm">
        {/* Tab bar */}
        <div className="flex items-center border-b border-border/50 px-4">
          <button className={tabClass("api-log")} onClick={() => setActiveTab("api-log")}>
            <Zap className="w-4 h-4" /> API Call Log
          </button>
          <button className={tabClass("whats-new")} onClick={() => setActiveTab("whats-new")}>
            <Sparkles className="w-4 h-4" /> What's New
          </button>
        </div>

        <CardHeader className="border-b border-border/50 bg-muted/5 py-3 px-6">
          {activeTab === "api-log" ? (
            <div className="flex items-center gap-3 flex-wrap">
              {/* Search box */}
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
                {apiCalls.length > 0 ? `${filteredApiCalls.length.toLocaleString()} of ${apiCalls.filter(c => selectedProfileId == null || c.profileId === selectedProfileId).length.toLocaleString()} entries` : "Waiting for activity…"}
              </p>
              {/* Profile filter picker */}
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
          ) : (
            <div className="flex items-center gap-2">
              <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <input
                type="text"
                placeholder="Filter change log items..."
                value={changelogFilter}
                onChange={e => setChangelogFilter(e.target.value)}
                className="text-xs bg-transparent outline-none text-foreground placeholder:text-muted-foreground w-64"
              />
            </div>
          )}
        </CardHeader>

        <CardContent className="p-0">
          {activeTab === "api-log" ? (
            <div className="overflow-y-auto overflow-x-hidden max-h-[70vh]">
              <table className="w-full text-sm text-left table-fixed">
                <colgroup>
                  <col className="w-36" />
                  <col className="w-40" />
                  <col className="w-36" />
                  <col className="w-20" />
                  <col />
                </colgroup>
                <thead className="text-xs uppercase bg-muted/30 text-muted-foreground font-bold border-b border-border/50 sticky top-0 z-10">
                  <tr>
                    <th className="px-3 py-4 font-bold bg-muted/30">Timestamp</th>
                    <th className="px-3 py-4 font-bold bg-muted/30">Account</th>
                    <th className="px-3 py-4 font-bold bg-muted/30">Operation</th>
                    <th className="px-3 py-4 font-bold bg-muted/30">Duration</th>
                    <th className="px-3 py-4 font-bold bg-muted/30">Message</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {initialLoading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <tr key={i} className="animate-pulse">
                        <td colSpan={5} className="px-3 py-4 bg-muted/10 h-12" />
                      </tr>
                    ))
                  ) : filteredApiCalls.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-12 text-center text-muted-foreground">
                        <Activity className="w-8 h-8 mx-auto mb-3 text-muted-foreground/30" />
                        <p className="text-sm font-medium">
                          {apiLogSearch.trim()
                            ? `No results for "${apiLogSearch}"`
                            : selectedProfileId != null
                            ? `No API calls for @${selectedProfile?.username ?? selectedProfileId}`
                            : "No API calls recorded yet"}
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
                    filteredApiCalls.map((call: any) => (
                      <tr key={call.id} className="hover:bg-accent/5 transition-colors">
                        <td className="px-3 py-3.5 text-muted-foreground text-xs font-mono truncate">
                          <span className="flex items-center gap-1 min-w-0">
                            <Clock className="w-3 h-3 shrink-0" />
                            <span className="truncate">{format(new Date(call.date), "MMM d, HH:mm:ss")}</span>
                          </span>
                        </td>
                        <td className="px-3 py-3.5 font-medium truncate">
                          <Link
                            href={`/profiles/${call.profileId}?tab=follow`}
                            className="flex items-center gap-1.5 text-foreground hover:text-primary transition-colors group min-w-0"
                          >
                            <User className="w-3.5 h-3.5 text-primary shrink-0" />
                            <span className="group-hover:underline underline-offset-2 truncate">
                              {getUsername(call.profileId)}
                            </span>
                          </Link>
                        </td>
                        <td className="px-3 py-3.5 truncate">
                          <span className="px-2 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-bold uppercase tracking-wider truncate inline-block max-w-full">
                            {call.operationName}
                          </span>
                        </td>
                        <td className="px-3 py-3.5 text-xs text-muted-foreground font-mono truncate">
                          {call.durationMs != null ? `${call.durationMs}ms` : "—"}
                        </td>
                        <td className="px-3 py-3.5 text-foreground truncate" title={call.message || undefined}>
                          {call.message || "—"}
                        </td>
                      </tr>
                    ))
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
                      <span className="text-xs text-muted-foreground">— {ver.date}</span>
                    </div>
                    <ul className="space-y-2">
                      {ver.items.map((item, i) => (
                        <li key={i} className="flex items-start gap-2.5 text-sm">
                          <span className="mt-0.5 shrink-0">
                            <span className={`inline-block text-[10px] font-bold px-1.5 py-0.5 rounded ${CATEGORY_COLORS[item.category] ?? "bg-muted text-muted-foreground"}`}>
                              {item.category}
                            </span>
                          </span>
                          <span className="text-foreground leading-relaxed">— {item.text}</span>
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
