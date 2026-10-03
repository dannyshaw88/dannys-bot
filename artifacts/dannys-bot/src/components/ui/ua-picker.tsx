import { userAgents } from "@shared/userAgents";
import { GroupedAgentPicker, type GroupedAgentPickerOption } from "./grouped-agent-picker";

export interface UaEntry { api: string; embedded: string; }

interface Props {
  value: string;
  onSelect: (ua: UaEntry) => void;
  fullWidth?: boolean;
}

function parseParts(api: string) {
  const p = api.split("; ");
  const androidVer = (p[0] ?? "").split("/")[1] ?? "";
  return {
    brand:   p[3] ?? "Unknown",
    model:   p[4] ?? api,
    dpi:     p[1] ?? "",
    android: androidVer ? `Android ${androidVer}` : "",
  };
}

const apiAgentOptions: GroupedAgentPickerOption[] = userAgents.map(ua => {
  const { brand, model, android, dpi } = parseParts(ua.api);
  return {
    value: ua.api,
    group: brand,
    label: model,
    detail: [android, dpi].filter(Boolean).join(" · "),
    searchText: ua.api,
  };
});

export function UaPickerDropdown({ value, onSelect, fullWidth }: Props) {
  return (
    <GroupedAgentPicker
      value={value || null}
      options={apiAgentOptions}
      onSelect={selectedValue => {
        const selected = userAgents.find(ua => ua.api === selectedValue);
        if (selected) onSelect(selected);
      }}
      fullWidth={fullWidth}
      placeholder="Pick a device…"
      searchPlaceholder="Search brand or model…"
      itemNoun="device"
      displayValue={value || undefined}
      buttonTitle={value || undefined}
    />
  );
}
