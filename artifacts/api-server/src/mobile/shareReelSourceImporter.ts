type ReelSource = { type: string; value: string };

type ReelSlotConfig<TSettings extends object> = {
  account?: { slots?: Array<{ slotId?: string }> };
  slotAutomation?: Record<string, TSettings>;
};

export type ReelSourceImportCounts = {
  totalSlots: number;
  addedSlots: number;
  alreadyPresentSlots: number;
};

/**
 * Add a Reel URL to every persisted account slot while changing no other
 * setting fields. The caller supplies the slot-key resolver so updates use
 * the same stable slot identity as the mobile settings routes.
 */
export function appendReelSourceToAllAccountSlots<TSettings extends object>(
  configs: Record<string, ReelSlotConfig<TSettings>>,
  reelUrl: string,
  getSlotSettingsKey: (serial: string, slotIdx: number, slotId?: string) => string,
  normalizeUrl: (value: string) => string | null,
): ReelSourceImportCounts {
  const counts: ReelSourceImportCounts = {
    totalSlots: 0,
    addedSlots: 0,
    alreadyPresentSlots: 0,
  };

  for (const [serial, instance] of Object.entries(configs)) {
    const slots = instance.account?.slots ?? [];
    for (let slotIdx = 0; slotIdx < slots.length; slotIdx++) {
      const slot = slots[slotIdx];
      const stableKey = getSlotSettingsKey(serial, slotIdx, slot.slotId);
      const existing = (
        instance.slotAutomation?.[stableKey] ??
        instance.slotAutomation?.[String(slotIdx)] ??
        {}
      ) as TSettings & { shareReelSources?: ReelSource[] };
      const sources = Array.isArray(existing.shareReelSources)
        ? existing.shareReelSources
        : [];

      counts.totalSlots++;
      if (sources.some(source =>
        typeof source?.value === "string" && normalizeUrl(source.value) === reelUrl
      )) {
        counts.alreadyPresentSlots++;
        continue;
      }

      instance.slotAutomation = {
        ...instance.slotAutomation,
        [stableKey]: {
          ...existing,
          shareReelSources: [...sources, { type: "link", value: reelUrl }],
        } as TSettings,
      };
      counts.addedSlots++;
    }
  }

  return counts;
}
