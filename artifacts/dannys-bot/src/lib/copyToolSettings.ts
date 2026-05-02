// Copies a subset of settings keys from a source tool's settings object
// to the same tool type on each target profile.
// Pass `enabled` to also copy the tool's start/stop state.
export async function copyToolSettingsToProfiles(
  sourceSettings: Record<string, unknown>,
  toolType: string,
  targetProfileIds: number[],
  settingKeys: string[],
  enabled?: boolean,
): Promise<void> {
  const patch: Record<string, unknown> = {};
  for (const key of settingKeys) {
    if (key in sourceSettings) patch[key] = sourceSettings[key];
  }

  const hasSettings = Object.keys(patch).length > 0;
  const hasEnabled  = enabled !== undefined;
  if (!hasSettings && !hasEnabled) return;

  await Promise.all(
    targetProfileIds.map(async profileId => {
      const res = await fetch(`/api/profiles/${profileId}/tools`, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to fetch tools for profile ${profileId}`);
      const tools: { id: number; type: string; settings: Record<string, unknown> }[] = await res.json();
      const tool = tools.find(t => t.type === toolType);
      if (!tool) return;
      const body: Record<string, unknown> = {};
      if (hasSettings) body.settings = { ...(tool.settings ?? {}), ...patch };
      if (hasEnabled)  body.enabled  = enabled;
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
