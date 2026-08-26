import { sqlite } from "@workspace/db";

function cleanModelLabel(value: string): string {
  const label = value
    .trim()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return label.toUpperCase() || "DEVICE";
}

/**
 * Return the stable Phone Farm slot number for a serial.
 *
 * The registry is the source of truth for the order shown in Phone Farm.
 * USB enumeration order and ADB serials are intentionally not used here.
 */
export function getPhoneFarmSlotIndex(serial: string): number | null {
  try {
    const row = sqlite
      .prepare("SELECT slot_index FROM phone_farm_devices WHERE serial = ?")
      .get(serial) as { slot_index?: number } | undefined;
    const slotIndex = row?.slot_index;
    return Number.isInteger(slotIndex) && slotIndex > 0 ? slotIndex : null;
  } catch {
    return null;
  }
}

/**
 * Name debugging evidence folders by Phone Farm order, not by device ID.
 *
 * Example: SLOT-1-REDMI-12. The optional label lets callers that already
 * have the current market name avoid a second device-property lookup.
 */
export function getDebugScreenshotFolderName(
  serial: string,
  deviceLabel?: string,
): string {
  let fallbackLabel = deviceLabel?.trim() ?? "";
  if (!fallbackLabel) {
    try {
      const row = sqlite
        .prepare("SELECT display_name, model, manufacturer FROM phone_farm_devices WHERE serial = ?")
        .get(serial) as {
          display_name?: string;
          model?: string;
          manufacturer?: string;
        } | undefined;
      fallbackLabel = row?.display_name?.trim() || row?.model?.trim() || serial;
      if (row?.manufacturer && fallbackLabel.toLowerCase().startsWith(row.manufacturer.toLowerCase())) {
        fallbackLabel = fallbackLabel.slice(row.manufacturer.length).trim();
      }
    } catch {
      fallbackLabel = serial;
    }
  }

  const model = cleanModelLabel(fallbackLabel);
  const slotIndex = getPhoneFarmSlotIndex(serial);
  return slotIndex === null
    ? `UNASSIGNED-${model}`
    : `SLOT-${slotIndex}-${model}`;
}