// Copies a subset of settings keys from a source tool's settings object
// to the same tool type on each target profile.
export async function copyToolSettingsToProfiles(
  sourceSettings: Record<string, unknown>,
  toolType: string,
  targetProfileIds: number[],
  settingKeys: string[],
): Promise<void> {
  const patch: Record<string, unknown> = {};
  for (const key of settingKeys) {
    if (key in sourceSettings) patch[key] = sourceSettings[key];
  }
  if (!Object.keys(patch).length) return;

  await Promise.all(
    targetProfileIds.map(async profileId => {
      const res = await fetch(`/api/profiles/${profileId}/tools`, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to fetch tools for profile ${profileId}`);
      const tools: { id: number; type: string; settings: Record<string, unknown> }[] = await res.json();
      const tool = tools.find(t => t.type === toolType);
      if (!tool) return; // tool doesn't exist yet on that profile — skip
      const merged = { ...(tool.settings ?? {}), ...patch };
      const updateRes = await fetch(`/api/tools/${tool.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: merged }),
        credentials: "include",
      });
      if (!updateRes.ok) throw new Error(`Failed to update tool ${tool.id}`);
    })
  );
}
