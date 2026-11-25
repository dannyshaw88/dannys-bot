export type FarmNavigationDevice = { serial: string; slotIndex: number };

export function adjacentFarmDevice(
  devices: FarmNavigationDevice[],
  currentSerial: string | null,
  direction: -1 | 1,
): string | null {
  const ordered = [...devices].sort((a, b) => a.slotIndex - b.slotIndex);
  if (ordered.length < 2) return null;
  const index = ordered.findIndex(device => device.serial === currentSerial);
  if (index < 0) return null;
  return ordered[index + direction]?.serial ?? null;
}
