import { Globe } from "lucide-react";
import { GroupedAgentPicker, type GroupedAgentPickerOption } from "./grouped-agent-picker";
import {
  describeEmbeddedBrowserAgent,
  embeddedBrowserAgentPresets,
} from "@shared/embeddedBrowserAgents";

const embeddedAgentOptions: GroupedAgentPickerOption[] = embeddedBrowserAgentPresets.map(preset => ({
  value: preset.userAgent,
  group: preset.brand,
  label: preset.model,
  detail: preset.detail,
  searchText: preset.searchText,
}));

interface Props {
  overrideUserAgent: string | null;
  pairedUserAgent: string;
  onSelect: (userAgent: string | null) => void;
  fullWidth?: boolean;
}

export function EmbeddedBrowserAgentPicker({
  overrideUserAgent,
  pairedUserAgent,
  onSelect,
  fullWidth,
}: Props) {
  const selectedPreset = embeddedBrowserAgentPresets.find(
    preset => preset.userAgent === overrideUserAgent
  );
  const buttonLabel = overrideUserAgent
    ? `Override · ${selectedPreset?.model ?? "custom agent"}`
    : "Match API device";

  return (
    <GroupedAgentPicker
      value={overrideUserAgent}
      options={embeddedAgentOptions}
      onSelect={onSelect}
      fullWidth={fullWidth}
      placeholder="Match API device"
      searchPlaceholder="Search brand or device model…"
      displayValue={buttonLabel}
      buttonTitle={overrideUserAgent ?? pairedUserAgent}
      icon={Globe}
      featuredOption={{
        label: "Match Device Identity",
        description: `${describeEmbeddedBrowserAgent(pairedUserAgent)} · follows the API device selection`,
      }}
    />
  );
}