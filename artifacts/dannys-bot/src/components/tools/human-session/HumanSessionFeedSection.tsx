import type { Dispatch, ReactNode, SetStateAction } from "react";
import { AlignLeft, Hash, Heart, Image as ImageIcon, Music, Repeat2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import { NumField } from "@/components/ui/num-field";

export interface HumanSessionFeedSectionProps {
  settings: Record<string, any>;
  setSettings: Dispatch<SetStateAction<Record<string, any>>>;
  pctInputs: (minKey: string, maxKey: string) => ReactNode;
}

export function HumanSessionFeedSection({
  settings,
  setSettings,
  pctInputs,
}: HumanSessionFeedSectionProps) {
  return (
    <>
            {/* ── View Timeline Feed ── */}
            <div className="px-4 py-3 space-y-1.5">
              {/* ROW 1: [✓] View Timeline Feed | Posts Min/Max | If 0 Posts→Follow Suggested | Reel View%  ——  Order % / Skip Chance on right */}
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 flex-wrap">
                  <input type="checkbox" id="viewTimelineFeedEnabled"
                    checked={!!settings.viewTimelineFeedEnabled}
                    onChange={(e) => setSettings({ ...settings, viewTimelineFeedEnabled: e.target.checked })}
                    className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                  />
                  <label htmlFor="viewTimelineFeedEnabled" className="font-semibold text-sm flex items-center gap-1.5 cursor-pointer select-none whitespace-nowrap shrink-0">
                    <ImageIcon className="w-4 h-4 text-blue-500 shrink-0" />
                    View Timeline Feed
                  </label>
                  <div className={`flex items-center gap-3 flex-wrap transition-opacity ${!settings.viewTimelineFeedEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Posts</span>
                      <Label className="text-xs text-muted-foreground">Min</Label>
                      <NumField min={1} max={100} className="w-14 h-7 text-xs"
                        value={settings.viewTimelineFeedMin ?? 3}
                        onChange={(v) => setSettings({ ...settings, viewTimelineFeedMin: v })}
                      />
                      <Label className="text-xs text-muted-foreground">Max</Label>
                      <NumField min={1} max={100} className="w-14 h-7 text-xs"
                        value={settings.viewTimelineFeedMax ?? 8}
                        onChange={(v) => setSettings({ ...settings, viewTimelineFeedMax: v })}
                      />
                    </div>
                  </div>
                </div>
                <div className="flex flex-col gap-1.5 shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Order %</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.viewTimelineFeedOrderMin ?? 0}
                      onChange={(v) => setSettings({ ...settings, viewTimelineFeedOrderMin: v })}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.viewTimelineFeedOrderMax ?? 0}
                      onChange={(v) => setSettings({ ...settings, viewTimelineFeedOrderMax: v })}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Skip Chance %</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.viewTimelineFeedNotUsedMin ?? 0}
                      onChange={(v) => setSettings({ ...settings, viewTimelineFeedNotUsedMin: v })}
                    />
                    <span className="text-[10px] text-muted-foreground">–</span>
                    <NumField min={0} max={100} className="w-14 h-7 text-xs"
                      value={settings.viewTimelineFeedNotUsedMax ?? 0}
                      onChange={(v) => setSettings({ ...settings, viewTimelineFeedNotUsedMax: v })}
                    />
                  </div>
                </div>
              </div>
              {/* Expand Caption% — click "more" on a % of viewed posts */}
              <div className={`flex items-center gap-3 flex-wrap pt-1.5 border-t border-border/40 transition-opacity ${!settings.viewTimelineFeedEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                <div className="flex items-center gap-1.5">
                  {pctInputs("expandCaptionPercentMin", "expandCaptionPercentMax")}
                  <AlignLeft className="w-3.5 h-3.5 text-sky-500 shrink-0" />
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Expand Caption%</span>
                </div>
              </div>
              {/* ROW 3: Tap Audio% — tap the music affordance on a post to browse the song's grid */}
              <div className={`flex items-center gap-3 flex-wrap pt-1.5 border-t border-border/40 transition-opacity ${!settings.viewTimelineFeedEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                <div className="flex items-center gap-1.5">
                  {pctInputs("tapAudioPercentMin", "tapAudioPercentMax")}
                  <Music className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Tap Audio%</span>
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">tap post audio to browse other posts with same song</span>
                </div>
              </div>
              {/* ROW 3b: Click Hashtag% — tap a hashtag in the caption to browse that hashtag's grid */}
              <div className={`flex items-center gap-3 flex-wrap pt-1.5 border-t border-border/40 transition-opacity ${!settings.viewTimelineFeedEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                <div className="flex items-center gap-1.5">
                  {pctInputs("clickHashtagPercentMin", "clickHashtagPercentMax")}
                  <Hash className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Click Hashtag%</span>
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">tap a caption hashtag, scroll grid, 1–10% chance to tap a post</span>
                </div>
              </div>
              {/* ROW 4 (was 2): Like Delay | Save Liked | Like% — left-aligned */}
              <div className={`flex items-center gap-3 flex-wrap pt-1.5 border-t border-border/40 transition-opacity ${!settings.viewTimelineFeedEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                <div className="flex items-center gap-1.5">
                  {pctInputs("likeTimelinePostsPercentMin", "likeTimelinePostsPercentMax")}
                  <Heart className="w-3.5 h-3.5 text-red-500 fill-red-500 shrink-0" />
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Like%</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Like Delay</span>
                  <Label className="text-xs text-muted-foreground">Min</Label>
                  <div className="relative">
                    <NumField min={0} max={300} className="w-14 h-7 text-xs pr-4"
                      value={settings.likeTimelinePostsDelayMin ?? 3}
                      onChange={(v) => setSettings({ ...settings, likeTimelinePostsDelayMin: v })}
                    />
                    <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">s</span>
                  </div>
                  <Label className="text-xs text-muted-foreground">Max</Label>
                  <div className="relative">
                    <NumField min={0} max={300} className="w-14 h-7 text-xs pr-4"
                      value={settings.likeTimelinePostsDelayMax ?? 8}
                      onChange={(v) => setSettings({ ...settings, likeTimelinePostsDelayMax: v })}
                    />
                    <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">s</span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Save Liked</span>
                  <input type="checkbox" id="saveMediaEnabled"
                    checked={!!settings.saveMediaEnabled}
                    onChange={(e) => setSettings({ ...settings, saveMediaEnabled: e.target.checked })}
                    className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
                  />
                  <div className={`flex items-center gap-1.5 transition-opacity ${!settings.saveMediaEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
                    <div className="relative">
                      <NumField min={1} max={100} className="w-14 h-7 text-xs pr-5"
                        value={settings.saveMediaPercent ?? 20}
                        onChange={(v) => setSettings({ ...settings, saveMediaPercent: v })}
                      />
                      <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">%</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground">of liked saved</span>
                  </div>
                </div>
                <div className="h-4 w-px bg-border/60 shrink-0" />
                <div className="flex items-center gap-1.5">
                  {pctInputs("sharePostPercentMin", "sharePostPercentMax")}
                  <Repeat2 className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Share%</span>
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">chance to share viewed posts to feed</span>
                </div>
              </div>
        {/* ── Visit Profile → View Feed → View Posts cascade ── */}
        {!!settings.viewTimelineFeedEnabled && (
          <div className="space-y-2 pt-1">

            {/* Visit Profile % — chance to visit the post author's profile directly from the feed */}
            <div className="flex items-center gap-2 flex-wrap pt-1.5 border-t border-border/40">
              {pctInputs("viewPostProfilePercentMin", "viewPostProfilePercentMax")}
              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">VIEW PROFILE%</span>
              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">CHANCE TO VISIT THE POST AUTHOR'S PROFILE</span>
            </div>

            {/* View Profile's Feed % + View Timeline Posts — on same row */}
            {(settings.viewPostProfilePercentMax ?? 0) > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                {pctInputs("viewProfileFeedPercentMin", "viewProfileFeedPercentMax")}
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">VIEW PROFILE'S FEED%</span>
                {(settings.viewProfileFeedPercentMax ?? 0) > 0 && (
                  <>
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">AMOUNT OF POSTS TO SCROLL ON</span>
                    <Label className="text-xs text-muted-foreground uppercase">Min</Label>
                    <NumField min={1} max={20} className="w-14 h-7 text-xs"
                      value={settings.viewProfilePostsCountMin ?? 1}
                      onChange={(v) => setSettings({ ...settings, viewProfilePostsCountMin: v })}
                    />
                    <Label className="text-xs text-muted-foreground uppercase">Max</Label>
                    <NumField min={1} max={20} className="w-14 h-7 text-xs"
                      value={settings.viewProfilePostsCountMax ?? 3}
                      onChange={(v) => setSettings({ ...settings, viewProfilePostsCountMax: v })}
                    />
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap">at</span>
                    {pctInputs("viewProfilePostsPercentMin", "viewProfilePostsPercentMax")}
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap">chance</span>
                  </>
                )}
              </div>
            )}

          </div>
        )}
      </div>
    </>
  );
}