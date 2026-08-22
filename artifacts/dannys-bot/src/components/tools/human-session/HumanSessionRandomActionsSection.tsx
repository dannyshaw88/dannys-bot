import type { Dispatch, ElementType, SetStateAction } from "react";
import { Bell, User, Settings, Bookmark, Zap } from "lucide-react";
import { NumField } from "@/components/ui/num-field";

export interface HumanSessionRandomActionsSectionProps {
  settings: Record<string, any>;
  setSettings: Dispatch<SetStateAction<Record<string, any>>>;
}

export function HumanSessionRandomActionsSection({
  settings,
  setSettings,
}: HumanSessionRandomActionsSectionProps) {
  return (
    <>
      {/* ── Random Actions ── */}
      <div className="px-4 py-3 space-y-2">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 shrink-0">
            <input type="checkbox" id="humanSessionEnabled"
              checked={!!settings.humanSessionEnabled}
              onChange={(e) => setSettings({ ...settings, humanSessionEnabled: e.target.checked })}
              className="w-3.5 h-3.5 accent-primary cursor-pointer shrink-0"
            />
            <label htmlFor="humanSessionEnabled" className="font-semibold text-sm flex items-center gap-2 cursor-pointer select-none whitespace-nowrap shrink-0">
              <User className="w-4 h-4 text-violet-500" />
              Random Actions
            </label>
          </div>
          <div className={`flex flex-col gap-1.5 shrink-0 transition-opacity ${!settings.humanSessionEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Order %</span>
              <NumField min={0} max={100} className="w-14 h-7 text-xs"
                value={settings.humanSessionOrderMin ?? 0}
                onChange={(v) => setSettings({ ...settings, humanSessionOrderMin: v })}
              />
              <span className="text-[10px] text-muted-foreground">–</span>
              <NumField min={0} max={100} className="w-14 h-7 text-xs"
                value={settings.humanSessionOrderMax ?? 0}
                onChange={(v) => setSettings({ ...settings, humanSessionOrderMax: v })}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap w-[116px] text-right">Skip Chance %</span>
              <NumField min={0} max={100} className="w-14 h-7 text-xs"
                value={settings.humanSessionNotUsedMin ?? 0}
                onChange={(v) => setSettings({ ...settings, humanSessionNotUsedMin: v })}
              />
              <span className="text-[10px] text-muted-foreground">–</span>
              <NumField min={0} max={100} className="w-14 h-7 text-xs"
                value={settings.humanSessionNotUsedMax ?? 0}
                onChange={(v) => setSettings({ ...settings, humanSessionNotUsedMax: v })}
              />
            </div>
          </div>
        </div>
        {/* Sub-row — all 5 jitter action chances on one row */}
        <div className={`flex items-center gap-1 transition-opacity ${!settings.humanSessionEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
          {([
            { minKey: "notificationsRunChanceMin",    maxKey: "notificationsRunChanceMax",    label: "Notifs",    Icon: Bell,      color: "text-orange-500" },
            { minKey: "ownProfileRunChanceMin",       maxKey: "ownProfileRunChanceMax",       label: "Profile",   Icon: User,      color: "text-indigo-500" },
            { minKey: "settingsActivityRunChanceMin", maxKey: "settingsActivityRunChanceMax", label: "Settings",  Icon: Settings,  color: "text-gray-500"   },
            { minKey: "viewActivityRunChanceMin",     maxKey: "viewActivityRunChanceMax",     label: "Activity",  Icon: Zap,       color: "text-yellow-500" },
            { minKey: "viewSavedRunChanceMin",        maxKey: "viewSavedRunChanceMax",        label: "Saved",     Icon: Bookmark,  color: "text-pink-500"   },
          ] as { minKey: string; maxKey: string; label: string; Icon: ElementType; color: string }[]).map(({ minKey, maxKey, label, Icon, color }) => (
            <div key={minKey} className="flex-1 flex flex-col items-center gap-0.5">
              <div className="flex items-center gap-1">
                <Icon className={`w-3 h-3 shrink-0 ${color}`} />
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide whitespace-nowrap">{label}</span>
              </div>
              <div className="flex items-center gap-0.5 w-full">
                <div className="relative flex-1">
                  <NumField min={0} max={100} className="w-full h-7 text-xs pr-4 pl-1"
                    value={(settings as any)[minKey] ?? 100}
                    onChange={v => setSettings({ ...settings, [minKey]: v } as any)}
                  />
                  <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground pointer-events-none">%</span>
                </div>
                <span className="text-[10px] text-muted-foreground">–</span>
                <div className="relative flex-1">
                  <NumField min={0} max={100} className="w-full h-7 text-xs pr-4 pl-1"
                    value={(settings as any)[maxKey] ?? 100}
                    onChange={v => setSettings({ ...settings, [maxKey]: v } as any)}
                  />
                  <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground pointer-events-none">%</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}