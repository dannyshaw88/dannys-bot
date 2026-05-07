// Copies a subset of settings keys from a source tool's settings object
// to the same tool type on each target profile.
// Pass `enabled` to also copy the tool's start/stop state.
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

  await Promise.all(
    targetProfileIds.map(async (profileId, i) => {
      const res = await fetch(`/api/profiles/${profileId}/tools`, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to fetch tools for profile ${profileId}`);
      const tools: { id: number; type: string; settings: Record<string, unknown> }[] = await res.json();
      const tool = tools.find(t => t.type === toolType);
      if (!tool) return;

      const settingsPatch = { ...patch };
      if (staggerOffsetMins && (staggerOffsetMins[i] ?? 0) > 0) {
        settingsPatch.staggerOffsetMins = staggerOffsetMins[i];
      }

      const body: Record<string, unknown> = {};
      if (Object.keys(settingsPatch).length > 0) body.settings = { ...(tool.settings ?? {}), ...settingsPatch };
      if (hasEnabled) body.enabled = enabled;
      const updateRes = await fetch(`/api/tools/${tool.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include",
      });
      if (!updateRes.ok) throw new Error(`Failed to update tool ${tool.id}`);
    })
  );
}
