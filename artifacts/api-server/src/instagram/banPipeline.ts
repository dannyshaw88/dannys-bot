import { storage } from "../storage";
import { computeAnalyticsContext } from "./analyticsContext";

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Full ban pipeline — called automatically whenever Instagram confirms an account
 * is banned/suspended, whether detected during Verify, automation (follow/DM/etc.),
 * or manually via the "Flag as Banned" button.
 *
 * Does three things atomically:
 *   1. Snapshots the account's API call history into ban_analytics
 *   2. Sets accountStatus → "banned" and appends a timestamped note
 *   3. Auto-pauses all other accounts on the same proxy for 90 min (IP taint window)
 */
export async function triggerBanPipeline(profileId: number, source: "auto-detect" | "verify" | "manual" = "auto-detect"): Promise<void> {
  const profile = await storage.getProfile(profileId).catch(() => null);
  if (!profile) return;

  if (profile.accountStatus === "banned") return;

  const allCalls = await storage.getInstagramApiCallsByProfile(profileId, 2000);
  const calls = allCalls.filter((c: { source?: string | null }) => c.source !== "HikerAPI");
  const snapshot = JSON.stringify(calls.map((c: { operationName: string; date: string; source?: string | null }) => ({
    operationName: c.operationName,
    date: c.date,
    source: c.source ?? null,
  })));

  let proxyHost = (profile as any).proxyHost ?? "";
  let proxyAccountCount = 0;
  if (profile.proxyId) {
    const proxies = await storage.getProxies().catch(() => []);
    const linked = proxies.find((p: { id: number; host: string }) => p.id === profile.proxyId);
    if (linked) proxyHost = linked.host;
    const sameProxy = await storage.getProfilesByProxyId(profile.proxyId).catch(() => []);
    proxyAccountCount = sameProxy.filter((p: { id: number; accountStatus?: string | null }) =>
      p.id !== profileId && p.accountStatus !== "banned"
    ).length;
  } else if (proxyHost) {
    const sameProxy = await storage.getProfilesByProxyHost(proxyHost).catch(() => []);
    proxyAccountCount = sameProxy.filter((p: { id: number; accountStatus?: string | null }) =>
      p.id !== profileId && p.accountStatus !== "banned"
    ).length;
  }

  const ctx = computeAnalyticsContext(calls, profile.notes, proxyAccountCount);

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`;
  const label = source === "manual" ? "Flagged as Banned" : source === "verify" ? "Auto-detected Banned (Verify)" : "Auto-detected Banned";
  const stamp = `${label}: ${ts}`;

  await storage.insertBanAnalytics({
    username: profile.username,
    proxyHost,
    bannedAt: now.toISOString(),
    endpointCount: calls.length,
    endpointSnapshot: snapshot,
    ...ctx,
    userAgentApi: (profile as any).userAgentApi ?? null,
    userAgentEmbedded: (profile as any).userAgentEmbedded ?? null,
    igDeviceState: (profile as any).igDeviceState ?? null,
    ebFingerprint: (profile as any).ebFingerprint ?? null,
    leakSnapshot: (profile as any).leakSnapshot ?? null,
  });

  const freshNotes = (await storage.getProfile(profileId).catch(() => null))?.notes ?? "";
  await storage.updateProfile(profileId, {
    accountStatus: "banned",
    notes: freshNotes ? `${freshNotes}\n${stamp}` : stamp,
  });

  console.log(`[ban-pipeline] @${profile.username} (id=${profileId}) — ${calls.length} calls snapshotted, status=banned [source=${source}]`);

  if (!profile.proxyId && !proxyHost) return;

  // Check Protect Accounts setting — if disabled, skip proxy taint entirely
  const globalSettings = await storage.getGlobalSettings().catch(() => ({} as Record<string, string>));
  const protectEnabled = globalSettings.protectAccountsEnabled === "true";
  if (!protectEnabled) {
    console.log(`[ban-pipeline] Protect Accounts disabled — skipping proxy taint for @${profile.username}`);
    return;
  }

  const minMins = Math.max(1, parseInt(globalSettings.protectAccountsMinMins ?? "60", 10));
  const maxMins = Math.max(minMins, parseInt(globalSettings.protectAccountsMaxMins ?? "120", 10));
  const taintMins = randInt(minMins, maxMins);
  const taintUntil = new Date(now.getTime() + taintMins * 60 * 1000).toISOString();

  const sameProxy = profile.proxyId
    ? await storage.getProfilesByProxyId(profile.proxyId).catch(() => [])
    : await storage.getProfilesByProxyHost(proxyHost).catch(() => []);
  console.log(`[ban-pipeline] @${profile.username} — found ${sameProxy.length} sibling(s) on proxy ${proxyHost || profile.proxyId}, taint window=${taintMins}min`);
  let pausedCount = 0;
  for (const sibling of sameProxy) {
    if (sibling.id === profileId || sibling.accountStatus === "banned" || !!sibling.resumingUntil) continue;
    await storage.updateProfile(sibling.id, {
      accountStatus: "stopped",
      resumingUntil: taintUntil,
      resumingPrevStatus: sibling.accountStatus,
    });
    console.log(`[ban-pipeline] Paused @${sibling.username} (proxy taint ${taintMins}min) — resumes at ${taintUntil}`);
    pausedCount++;
  }
  console.log(`[ban-pipeline] Proxy taint complete — paused ${pausedCount} account(s) on proxy ${proxyHost || profile.proxyId}`);
}
