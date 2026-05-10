// Copies a subset of settings keys from a source tool's settings object
// to the same tool type on each target profile.
//
// TWO-PHASE WRITE to eliminate the race condition:
//   Phase 1 save settings (including staggerOffsetMins) for ALL profiles.
//              No enable signal is sent, so no reconcile fires yet.
//   Phase 2 send enabled=true for ALL profiles (only if requested).
//              By now every profile's staggerOffsetMins is already in the DB,
//              so whichever reconcile runs first will read the correct value.
//
// Pass `staggerOffsetMins` (one entry per target profile) to spread start
// times across the configured wait window when randomiseTiming is active.
export async function copyToolSettingsToProfiles(
  sourceSettings: Record<string, unknown>,
  toolType: string,
  targetProfileIds: number[],
  settingKeys: string[],
  enabled?: boolean,
  staggerOffsetMins?: number[],
): Promise<void> {
  const patch: Record<string, unknown> = {};
  for (const key of settingKeys) {
    if (key in sourceSettings) patch[key] = sourceSettings[key];
  }

  const hasEnabled = enabled !== undefined;
  const hasStagger = Array.isArray(staggerOffsetMins) && staggerOffsetMins.some(o => o > 0);
  const hasSettings = Object.keys(patch).length > 0 || hasStagger;
  if (!hasSettings && !hasEnabled) return;

  // ── Fetch all target tools up front ──────────────────────────────────────
  const toolRecords = await Promise.all(
    targetProfileIds.map(async profileId => {
      const res = await fetch(`/api/profiles/${profileId}/tools`, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to fetch tools for profile ${profileId}`);
      const tools: { id: number; type: string; settings: Record<string, unknown> }[] = await res.json();
      return { profileId, tool: tools.find(t => t.type === toolType) ?? null };
    })
  );

  // ── PHASE 1: save settings + stagger for all profiles (no enable yet) ───
  if (hasSettings) {
    await Promise.all(
      toolRecords.map(async ({ profileId, tool }, i) => {
        if (!tool) return;
        const settingsPatch = { ...patch };
        if (staggerOffsetMins && (staggerOffsetMins[i] ?? 0) > 0) {
          settingsPatch.staggerOffsetMins = staggerOffsetMins[i];
          console.log(`[copySettings] profile ${profileId} staggerOffsetMins=${staggerOffsetMins[i]}`);
        }
        if (Object.keys(settingsPatch).length === 0) return;
        const body = { settings: { ...(tool.settings ?? {}), ...settingsPatch } };
        const res = await fetch(`/api/tools/${tool.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          credentials: "include",
        });
        if (!res.ok) throw new Error(`Failed to save settings for tool ${tool.id} (profile ${profileId})`);
      })
    );
  }

  // ── PHASE 2: enable/disable all profiles (now that stagger is committed) ─
  // `cold: true` tells the server to stop any running runner and relaunch it
  // with a full startup wait, so the staggerOffsetMins saved in Phase 1 applies.
  if (hasEnabled) {
    await Promise.all(
      toolRecords.map(async ({ profileId, tool }) => {
        if (!tool) return;
        const body = enabled === true ? { enabled, cold: true } : { enabled };
        const res = await fetch(`/api/tools/${tool.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          credentials: "include",
        });
        if (!res.ok) throw new Error(`Failed to set enabled=${enabled} for tool ${tool.id} (profile ${profileId})`);
      })
    );
  }
}
