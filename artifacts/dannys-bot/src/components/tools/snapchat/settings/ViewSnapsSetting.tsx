import { NumberRangeFields } from "./NumberRangeFields";
import type { ViewSnapsSettings } from "@/pages/snapchatSettings/viewSnaps";
import { ToolSettingFrame } from "./ToolSettingFrame";

type ViewSnapsSettingProps = {
  value: ViewSnapsSettings;
  loading: boolean;
  onUpdate: (patch: Partial<ViewSnapsSettings>) => void;
};

export function ViewSnapsSetting({ value, loading, onUpdate }: ViewSnapsSettingProps) {
  return (
    <ToolSettingFrame
      title="View Snaps"
      countLabel="Snaps"
      countFloor={1}
      value={value}
      loading={loading}
      onUpdate={onUpdate}
    >
      <NumberRangeFields
        label="Seconds"
        minValue={value.watchSecondsMin}
        maxValue={value.watchSecondsMax}
        min={1}
        max={60}
        disabled={loading || !value.enabled}
        onMinChange={watchSecondsMin => onUpdate({ watchSecondsMin })}
        onMaxChange={watchSecondsMax => onUpdate({ watchSecondsMax })}
      />
    </ToolSettingFrame>
  );
}
