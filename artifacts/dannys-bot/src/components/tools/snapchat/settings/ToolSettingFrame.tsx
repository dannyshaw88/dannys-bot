import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export type SnapchatCoreToolSettings = {
  enabled: boolean;
  min: number;
  max: number;
  activatePctMin: number;
  activatePctMax: number;
};

type ToolSettingFrameProps = {
  title: string;
  countLabel: string;
  countFloor: number;
  value: SnapchatCoreToolSettings;
  loading: boolean;
  onUpdate: (patch: Partial<SnapchatCoreToolSettings>) => void;
  children?: ReactNode;
  childrenBelow?: ReactNode;
};

const clamp4 = (value: number) =>
  Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0)));

export function ToolSettingFrame({
  title,
  countLabel,
  countFloor,
  value,
  loading,
  onUpdate,
  children,
  childrenBelow,
}: ToolSettingFrameProps) {
  const disabled = loading || !value.enabled;
  const countValue = (number: number) => countFloor ? Math.max(countFloor, number) : number;
  return (
    <div className="rounded-lg border border-border/70 p-4 space-y-3">
      <div className="flex min-w-0 flex-nowrap items-center gap-2">
        <div className="flex shrink-0 items-center gap-2 min-w-[155px]">
          <Switch
            checked={value.enabled}
            onCheckedChange={enabled => onUpdate({ enabled })}
            disabled={loading}
          />
          <span className="whitespace-nowrap text-[11px] font-semibold text-foreground">{title}</span>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap">
          <div className="flex shrink-0 items-center gap-1 whitespace-nowrap">
            <Label className="text-[11px] text-muted-foreground">Chance %</Label>
            <Input
              type="number"
              min={0}
              max={100}
              className="box-content w-[3ch] h-7 px-1 text-center text-xs"
              value={Math.max(0, Math.min(100, value.activatePctMin))}
              onChange={event => onUpdate({ activatePctMin: Math.max(0, Math.min(100, clamp4(Number(event.target.value)))) })}
              disabled={disabled}
            />
            <span className="text-xs text-muted-foreground">–</span>
            <Input
              type="number"
              min={0}
              max={100}
              className="box-content w-[3ch] h-7 px-1 text-center text-xs"
              value={Math.max(0, Math.min(100, value.activatePctMax))}
              onChange={event => onUpdate({ activatePctMax: Math.max(0, Math.min(100, clamp4(Number(event.target.value)))) })}
              disabled={disabled}
            />
          </div>
          <div className="flex shrink-0 items-center gap-1 whitespace-nowrap">
            <Label className="text-[11px] text-muted-foreground">{countLabel}</Label>
            <Input
              type="number"
              min={countFloor}
              className="box-content w-[3ch] h-7 px-1 text-center text-xs"
              value={countValue(value.min)}
              onChange={event => onUpdate({ min: Math.max(countFloor, clamp4(Number(event.target.value))) })}
              disabled={disabled}
            />
            <span className="text-xs text-muted-foreground">–</span>
            <Input
              type="number"
              min={countFloor}
              className="box-content w-[3ch] h-7 px-1 text-center text-xs"
              value={countValue(value.max)}
              onChange={event => onUpdate({ max: Math.max(countFloor, clamp4(Number(event.target.value))) })}
              disabled={disabled}
            />
          </div>
          {children}
        </div>
      </div>
      {childrenBelow}
    </div>
  );
}
