import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Film, Heart, Percent, PlaySquare } from "lucide-react";
import { Label } from "@/components/ui/label";
import { NumField } from "@/components/ui/num-field";

export interface HumanSessionViewReelsSectionProps {
  settings: Record<string, any>;
  setSettings: Dispatch<SetStateAction<Record<string, any>>>;
  pctInputs: (minKey: string, maxKey: string) => ReactNode;
}

export function HumanSessionViewReelsSection({ settings, setSettings, pctInputs }: HumanSessionViewReelsSectionProps) {
  const enabled = !!settings.viewReelsEnabled;
  return <div className="px-4 py-3 space-y-2">
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2.5">
        <input type="checkbox" id="viewReelsEnabled" checked={enabled} onChange={e => setSettings({ ...settings, viewReelsEnabled: e.target.checked })} className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0" />
        <label htmlFor="viewReelsEnabled" className="font-semibold text-sm flex items-center gap-1.5 cursor-pointer select-none whitespace-nowrap shrink-0"><Film className="w-4 h-4 text-violet-500 shrink-0" />View Reels</label>
      </div>
      <div className={`flex flex-col gap-1.5 shrink-0 transition-opacity ${!enabled ? "opacity-40 pointer-events-none" : ""}`}>
        {(["Order", "Skip Chance"] as const).map((label, i) => {
          const base = i ? "viewReelsNotUsed" : "viewReelsOrder";
          return <div className="flex items-center gap-2" key={label}><span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">{label} %</span>
            <NumField min={0} max={100} className="w-14 h-7 text-xs" value={settings[`${base}Min`] ?? 0} onChange={v => setSettings({ ...settings, [`${base}Min`]: v })} />
            <span className="text-[10px] text-muted-foreground">–</span>
            <NumField min={0} max={100} className="w-14 h-7 text-xs" value={settings[`${base}Max`] ?? 0} onChange={v => setSettings({ ...settings, [`${base}Max`]: v })} />
          </div>;
        })}
      </div>
    </div>
    <div className={`flex items-center gap-2.5 flex-wrap transition-opacity ${!enabled ? "opacity-40 pointer-events-none" : ""}`}>
      <div className="flex items-center gap-1.5">{pctInputs("reelWatchChanceMin", "reelWatchChanceMax")}<Percent className="w-3.5 h-3.5 text-orange-500 shrink-0" /><span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Chance%</span></div>
      <div className="h-4 w-px bg-border/60 shrink-0" />
      <div className="flex items-center gap-1.5"><Label className="text-xs text-muted-foreground uppercase">Min</Label><NumField min={0} max={50} className="w-16 h-7 text-xs" value={settings.reelWatchCountMin ?? 1} onChange={v => setSettings({ ...settings, reelWatchCountMin: v })} /><Label className="text-xs text-muted-foreground uppercase">Max</Label><NumField min={0} max={50} className="w-16 h-7 text-xs" value={settings.reelWatchCountMax ?? 3} onChange={v => setSettings({ ...settings, reelWatchCountMax: v })} /><span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Reels/Op</span></div>
      <div className="h-4 w-px bg-border/60 shrink-0" />
      <div className="flex items-center gap-1.5">{pctInputs("reelWatchPercentMin", "reelWatchPercentMax")}<PlaySquare className="w-3.5 h-3.5 text-indigo-500 shrink-0" /><span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Reel View%</span></div>
      <div className="h-4 w-px bg-border/60 shrink-0" />
      <div className="flex items-center gap-1.5">{pctInputs("reelLikePercentMin", "reelLikePercentMax")}<Heart className="w-3.5 h-3.5 text-rose-500 shrink-0" /><span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Reel Like%</span></div>
    </div>
  </div>;
}