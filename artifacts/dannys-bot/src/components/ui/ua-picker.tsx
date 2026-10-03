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
  const rawBrand = p[3] ?? "Unknown";
  const brandKey = rawBrand.toLowerCase();
  const brand = brandKey.includes("samsung") ? "Samsung"
    : brandKey.includes("google") ? "Google"
    : brandKey.includes("motorola") ? "Motorola"
    : brandKey.includes("oneplus") ? "OnePlus"
    : brandKey.includes("xiaomi") || brandKey.includes("redmi") ? "Xiaomi"
    : brandKey.includes("huawei") || brandKey.includes("honor") ? "Huawei / Honor"
    : brandKey.includes("realme") ? "realme"
    : rawBrand;
  return {
    brand,
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
