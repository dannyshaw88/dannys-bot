import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { MassSnapSettings } from "@/pages/snapchatSettings/massSnap";
import { clampSettingNumber } from "./NumberRangeFields";
import { ToolSettingFrame } from "./ToolSettingFrame";

type MassSnapSettingProps = {
  value: MassSnapSettings;
  loading: boolean;
  onUpdate: (patch: Partial<MassSnapSettings>) => void;
};

export function MassSnapSetting({ value, loading, onUpdate }: MassSnapSettingProps) {
  return (
    <ToolSettingFrame
      title="Mass Snap"
      countLabel="Select"
      countFloor={1}
      value={value}
      loading={loading}
      onUpdate={onUpdate}
      childrenBelow={(
        <p className="pt-1 text-xs text-muted-foreground">
          Configuration only; Snapchat recipient selection and sending are not connected yet.
        </p>
      )}
    >
      <div className="flex shrink-0 items-center gap-1 whitespace-nowrap">
        <Label className="text-[11px] text-muted-foreground">Swipe (px)</Label>
        <Input
          type="number"
          min={40}
          max={1000}
          className="box-content w-[3ch] h-7 px-1 text-center text-xs"
          value={Math.max(40, Math.min(1000, value.contactScrollPixels))}
          onChange={event => onUpdate({
            contactScrollPixels: Math.max(40, Math.min(1000, clampSettingNumber(Number(event.target.value)))),
          })}
          disabled={loading || !value.enabled}
        />
      </div>
    </ToolSettingFrame>
  );
}
