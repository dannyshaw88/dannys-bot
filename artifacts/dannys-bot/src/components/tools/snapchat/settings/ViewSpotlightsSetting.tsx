import { NumberRangeFields } from "./NumberRangeFields";
import type { ViewStoriesSettings } from "@/pages/snapchatSettings/viewStories";
import { ToolSettingFrame } from "./ToolSettingFrame";

type ViewSpotlightsSettingProps = {
  value: ViewStoriesSettings;
  loading: boolean;
  onUpdate: (patch: Partial<ViewStoriesSettings>) => void;
};

export function ViewSpotlightsSetting({ value, loading, onUpdate }: ViewSpotlightsSettingProps) {
  const disabled = loading || !value.enabled;
  return (
    <ToolSettingFrame
      title="View Spotlights"
      countLabel="Swipes"
      countFloor={1}
      value={value}
      loading={loading}
      onUpdate={onUpdate}
    >
      <NumberRangeFields
        label="Like %"
        minValue={value.likePercentMin}
        maxValue={value.likePercentMax}
        min={0}
        max={100}
        disabled={disabled}
        onMinChange={likePercentMin => onUpdate({ likePercentMin })}
        onMaxChange={likePercentMax => onUpdate({ likePercentMax })}
      />
      <NumberRangeFields
        label="Seconds"
        minValue={value.watchSecondsMin}
        maxValue={value.watchSecondsMax}
        min={1}
        max={60}
        disabled={disabled}
        onMinChange={watchSecondsMin => onUpdate({ watchSecondsMin })}
        onMaxChange={watchSecondsMax => onUpdate({ watchSecondsMax })}
      />
    </ToolSettingFrame>
  );
}
