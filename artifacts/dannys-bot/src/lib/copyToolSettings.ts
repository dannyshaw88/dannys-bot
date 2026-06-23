// Copies a subset of settings keys from a source tool's settings object
// to the same tool type on each target profile.
//
// TWO-PHASE WRITE to eliminate the race condition:
//   Phase 1 save settings (including staggerOffsetMins) for ALL profiles.
//              No enable signal is sent, so no reconcile fires yet.
//   Phase 2 send enabled signal for profiles that need it (only if requested).
//              By now every profile's staggerOffsetMins is already in the DB,
//              so whichever reconcile runs first will read the correct value.
//
// Cold-restart rules (Fixes #5 & #6):
//   - enabled=true + stagger > 0 → cold=true (restart with stagger delay)
//   - enabled=true + stagger = 0 + tool already running → SKIP (don't interrupt)
//   - enabled=true + stagger = 0 + tool was off → enable normally (no cold)
//   - enabled=false → always send to disable
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
      const tools: { id: number; type: string; enabled: boolean; settings: Record<string, unknown> }[] = await res.json();
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

  // ── PHASE 2: enable/disable (respecting cold-restart rules) ──────────────
  if (hasEnabled) {
    await Promise.all(
      toolRecords.map(async ({ profileId, tool }, i) => {
        if (!tool) return;
        const stagger = staggerOffsetMins?.[i] ?? 0;
        const hasCold = stagger > 0;
        const alreadyEnabled = !!tool.enabled;

        if (enabled === true) {
          if (!hasCold && alreadyEnabled) {
            // Tool is already running and no stagger: don't interrupt it.
            // The new settings written in Phase 1 will apply on its next cycle.
            return;
          }
          const body = hasCold ? { enabled: true, cold: true } : { enabled: true };
          const res = await fetch(`/api/tools/${tool.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            credentials: "include",
          });
          if (!res.ok) throw new Error(`Failed to set enabled=true for tool ${tool.id} (profile ${profileId})`);
        } else {
          // Disabling: always send
          const res = await fetch(`/api/tools/${tool.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }),
            credentials: "include",
          });
          if (!res.ok) throw new Error(`Failed to set enabled=${enabled} for tool ${tool.id} (profile ${profileId})`);
        }
      })
    );
  }

}
