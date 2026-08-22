import type { Dispatch, SetStateAction } from "react";
import { Globe, ExternalLink, Repeat2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NumField } from "@/components/ui/num-field";
import { Textarea } from "@/components/ui/textarea";

type WebBrowsingActivity = {
  sessionAt: number;
  sites: Array<{
    url: string;
    visitedAt: number;
    scrollTimeSec: number;
    linksVisited: string[];
  }>;
  error?: string;
};

export interface HumanSessionWebBrowsingSectionProps {
  settings: Record<string, any>;
  setSettings: Dispatch<SetStateAction<Record<string, any>>>;
  webBrowsingTab: "settings" | "log";
  setWebBrowsingTab: Dispatch<SetStateAction<"settings" | "log">>;
  cbActivity: WebBrowsingActivity[] | undefined;
  handleSplitWebsites: () => Promise<void>;
}

export function HumanSessionWebBrowsingSection({
  settings,
  setSettings,
  webBrowsingTab,
  setWebBrowsingTab,
  cbActivity,
  handleSplitWebsites,
}: HumanSessionWebBrowsingSectionProps) {
  return (
    <>
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
    </>
  );
}