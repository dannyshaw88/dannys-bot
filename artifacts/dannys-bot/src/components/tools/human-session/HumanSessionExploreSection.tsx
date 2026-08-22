import type { Dispatch, SetStateAction } from "react";
import { Compass, Heart, User } from "lucide-react";
import { Label } from "@/components/ui/label";
import { NumField } from "@/components/ui/num-field";

export interface HumanSessionExploreSectionProps {
  settings: Record<string, any>;
  setSettings: Dispatch<SetStateAction<Record<string, any>>>;
}

export function HumanSessionExploreSection({
  settings,
  setSettings,
}: HumanSessionExploreSectionProps) {
  return (
    <>
            {/* ── Visit Explore Page ── */}
            <div className="px-4 py-3 space-y-2">
              {/* Title row */}
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2.5">
                  <input type="checkbox" id="followSuggestedUsersIfEmptyEnabled"
                    checked={!!(settings as any).followSuggestedUsersIfEmptyEnabled}
                    onChange={(e) => setSettings({ ...settings, followSuggestedUsersIfEmptyEnabled: e.target.checked } as any)}
                    className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                  />
                  <label htmlFor="followSuggestedUsersIfEmptyEnabled" className="font-semibold text-sm flex items-center gap-1.5 cursor-pointer select-none whitespace-nowrap shrink-0">
                    <Compass className="w-4 h-4 text-cyan-500 shrink-0" />
                    Visit Explore Page
                  </label>
                </div>
                <div className={`flex flex-col gap-1.5 shrink-0 transition-opacity ${!(settings as any).followSuggestedUsersIfEmptyEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Order %</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={(settings as any).explorePageOrderMin ?? 0}
                      onChange={(v) => setSettings({ ...settings, explorePageOrderMin: v } as any)}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={(settings as any).explorePageOrderMax ?? 0}
                      onChange={(v) => setSettings({ ...settings, explorePageOrderMax: v } as any)}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Skip Chance %</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={(settings as any).explorePageSkipMin ?? 0}
                      onChange={(v) => setSettings({ ...settings, explorePageSkipMin: v } as any)}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={(settings as any).explorePageSkipMax ?? 0}
                      onChange={(v) => setSettings({ ...settings, explorePageSkipMax: v } as any)}
                    />
                  </div>
                </div>
              </div>
              {/* Sub-settings */}
              {!!(settings as any).followSuggestedUsersIfEmptyEnabled && (
                <div className="space-y-1.5 pl-5">
                  {/* Row 1: Posts to scroll on Explore */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Label className="text-xs text-muted-foreground uppercase">Min</Label>
                    <NumField min={1} max={100} className="w-14 h-7 text-xs"
                      value={(settings as any).exploreScrollMin ?? 5}
                      onChange={(v) => setSettings({ ...settings, exploreScrollMin: v } as any)}
                    />
                    <Label className="text-xs text-muted-foreground uppercase">Max</Label>
                    <NumField min={1} max={100} className="w-14 h-7 text-xs"
                      value={(settings as any).exploreScrollMax ?? 15}
                      onChange={(v) => setSettings({ ...settings, exploreScrollMax: v } as any)}
                    />
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Posts to Scroll on Explore</span>
                  </div>
                  {/* Row 2: Posts to click on */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Label className="text-xs text-muted-foreground uppercase">Min</Label>
                    <NumField min={0} max={50} className="w-14 h-7 text-xs"
                      value={(settings as any).exploreClickMin ?? 1}
                      onChange={(v) => setSettings({ ...settings, exploreClickMin: v } as any)}
                    />
                    <Label className="text-xs text-muted-foreground uppercase">Max</Label>
                    <NumField min={0} max={50} className="w-14 h-7 text-xs"
                      value={(settings as any).exploreClickMax ?? 3}
                      onChange={(v) => setSettings({ ...settings, exploreClickMax: v } as any)}
                    />
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Posts to Click On</span>
                  </div>
                  {/* Row 3: Like % */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <div className="flex items-center gap-1.5">
                      <Label className="text-xs text-muted-foreground uppercase">Min</Label>
                      <div className="relative">
                        <NumField min={0} max={100} className="w-14 h-7 text-xs pr-5"
                          value={(settings as any).exploreLikePctMin ?? 0}
                          onChange={(v) => setSettings({ ...settings, exploreLikePctMin: v } as any)}
                        />
                        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Label className="text-xs text-muted-foreground uppercase">Max</Label>
                      <div className="relative">
                        <NumField min={0} max={100} className="w-14 h-7 text-xs pr-5"
                          value={(settings as any).exploreLikePctMax ?? 30}
                          onChange={(v) => setSettings({ ...settings, exploreLikePctMax: v } as any)}
                        />
                        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                      </div>
                    </div>
                    <Heart className="w-3.5 h-3.5 text-red-500 fill-red-500 shrink-0" />
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Like%</span>
                  </div>
                  {/* Row 4: Visit Author's Profile % */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <div className="flex items-center gap-1.5">
                      <Label className="text-xs text-muted-foreground uppercase">Min</Label>
                      <div className="relative">
                        <NumField min={0} max={100} className="w-14 h-7 text-xs pr-5"
                          value={(settings as any).exploreVisitProfilePctMin ?? 0}
                          onChange={(v) => setSettings({ ...settings, exploreVisitProfilePctMin: v } as any)}
                        />
                        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Label className="text-xs text-muted-foreground uppercase">Max</Label>
                      <div className="relative">
                        <NumField min={0} max={100} className="w-14 h-7 text-xs pr-5"
                          value={(settings as any).exploreVisitProfilePctMax ?? 20}
                          onChange={(v) => setSettings({ ...settings, exploreVisitProfilePctMax: v } as any)}
                        />
                        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                      </div>
                    </div>
                    <User className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Visit Author's Profile%</span>
                  </div>
                  {/* Row 5: Posts to scroll on profile */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Label className="text-xs text-muted-foreground uppercase">Min</Label>
                    <NumField min={1} max={50} className="w-14 h-7 text-xs"
                      value={(settings as any).exploreProfileScrollMin ?? 3}
                      onChange={(v) => setSettings({ ...settings, exploreProfileScrollMin: v } as any)}
                    />
                    <Label className="text-xs text-muted-foreground uppercase">Max</Label>
                    <NumField min={1} max={50} className="w-14 h-7 text-xs"
                      value={(settings as any).exploreProfileScrollMax ?? 8}
                      onChange={(v) => setSettings({ ...settings, exploreProfileScrollMax: v } as any)}
                    />
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Posts to Scroll on Profile</span>
                  </div>
                  {/* Row 6: Posts to click on profile */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Label className="text-xs text-muted-foreground uppercase">Min</Label>
                    <NumField min={0} max={20} className="w-14 h-7 text-xs"
                      value={(settings as any).exploreProfileClickMin ?? 1}
                      onChange={(v) => setSettings({ ...settings, exploreProfileClickMin: v } as any)}
                    />
                    <Label className="text-xs text-muted-foreground uppercase">Max</Label>
                    <NumField min={0} max={20} className="w-14 h-7 text-xs"
                      value={(settings as any).exploreProfileClickMax ?? 3}
                      onChange={(v) => setSettings({ ...settings, exploreProfileClickMax: v } as any)}
                    />
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Posts to Click on Profile</span>
                  </div>
                </div>
              )}
            </div>
    </>
  );
}