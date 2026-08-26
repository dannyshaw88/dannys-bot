import { runAppSwitch } from "./appSwitch";
import { runCheckNotifications } from "./checkNotifications";
import { runVisitOwnProfile } from "./visitOwnProfile";
import { runVisitSaved } from "./visitSaved";
import { runVisitSettings } from "./visitSettings";

/** Services supplied by the HST cycle; this operation owns no cycle state. */
export interface RandomActionsOperationContext {
  android: any;
  getScreenSize: (serial: string) => { w: number; h: number };
  getDeviceDensity: (serial: string) => Promise<number>;
  deviceProfileSwipe: (...args: any[]) => Promise<void>;
  sleepOrAbort: (serial: string, milliseconds: number, category?: any) => Promise<void>;
  hstRandomDelay: (serial: string, minimumMs: number, maximumMs: number) => Promise<void>;
  rollRange: (minimum: number, maximum: number) => number;
  logger: any;
  isCycleAborted?: (serial: string) => boolean;
  detectors?: Record<string, unknown>;
  safety?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  config?: Record<string, unknown>;
  sharedState?: Map<string, unknown>;
  runUpdateProfilePicture: (...args: any[]) => Promise<void>;
  runUpdateBio: (...args: any[]) => Promise<void>;
}

export interface RandomActionsOptions {
  checkNotificationsPctMin: number; checkNotificationsPctMax: number;
  checkNotificationsScrollsMin: number; checkNotificationsScrollsMax: number;
  checkNotificationsClickPctMin: number; checkNotificationsClickPctMax: number;
  visitProfilePctMin: number; visitProfilePctMax: number;
  visitSavedPctMin: number; visitSavedPctMax: number;
  visitSettingsPctMin: number; visitSettingsPctMax: number;
  appSwitchPctMin: number; appSwitchPctMax: number;
  updateProfilePicEnabled?: boolean; updateProfilePicFolderPath?: string;
  updateProfilePicAlterationEnabled?: boolean; updateProfilePicAlterationLevel?: "small" | "medium" | "high";
  updateProfilePicImageSettingsEnabled?: boolean; updateProfilePicImageSettings?: any;
  updateProfilePicFixAiSlop?: boolean; updateProfilePicMetadataCleanup?: boolean;
  updateProfilePicFrequencyDisruption?: boolean; updateProfilePicDisableAfterUsed?: boolean;
  updateBioActivatePctMin?: number; updateBioActivatePctMax?: number;
  updateBioText?: string; updateBioDisableAfterUsed?: boolean;
  slotIdx?: number; slotAutomationKey?: string;
}

/** Run the complete, deliberately ordered Random Actions sequence. */
export async function runRandomActionsStep(
  serial: string,
  onLog: (message: string) => void,
  opts: RandomActionsOptions,
  context: RandomActionsOperationContext,
  mutateAfter?: (kind: "profile" | "bio") => Promise<void>,
): Promise<boolean> {
  const { rollRange } = context;
  let fired = false;
  const notifChance = rollRange(opts.checkNotificationsPctMin, opts.checkNotificationsPctMax) / 100;
  if (notifChance > 0 && Math.random() < notifChance) {
    onLog("Random Actions: checking notifications…");
    await runCheckNotifications(serial, {
      scrollsMin: opts.checkNotificationsScrollsMin, scrollsMax: opts.checkNotificationsScrollsMax,
      clickPctMin: opts.checkNotificationsClickPctMin, clickPctMax: opts.checkNotificationsClickPctMax,
    }, { ...context, onLog: (message: string) => onLog(`  ${message}`) });
    fired = true;
  }
  const profileChance = rollRange(opts.visitProfilePctMin, opts.visitProfilePctMax) / 100;
  if (profileChance > 0 && Math.random() < profileChance) {
    onLog("Random Actions: visiting own profile…");
    await runVisitOwnProfile(serial, { ...context, onLog: (message: string) => onLog(`  ${message}`) });
    fired = true;
    await mutateAfter?.("profile");
  }
  const savedChance = rollRange(opts.visitSavedPctMin, opts.visitSavedPctMax) / 100;
  if (savedChance > 0 && Math.random() < savedChance) {
    onLog("Random Actions: visiting saved posts…");
    await runVisitSaved(serial, { ...context, onLog: (message: string) => onLog(`  ${message}`) });
    fired = true;
  }
  const settingsChance = rollRange(opts.visitSettingsPctMin, opts.visitSettingsPctMax) / 100;
  if (settingsChance > 0 && Math.random() < settingsChance) {
    onLog("Random Actions: visiting random settings…");
    const settingsVisited = await runVisitSettings(serial, { ...context, onLog: (message: string) => onLog(`  ${message}`) });
    fired = settingsVisited || fired;
  }
  const appSwitchChance = rollRange(opts.appSwitchPctMin, opts.appSwitchPctMax) / 100;
  if (appSwitchChance > 0 && Math.random() < appSwitchChance) {
    onLog("Random Actions: app switch (SMS)…");
    await runAppSwitch(serial, { ...context, onLog: (message: string) => onLog(`  ${message}`) });
    fired = true;
  }
  const profilePicChance = rollRange(opts.updateProfilePicEnabled ? 100 : 0, opts.updateProfilePicEnabled ? 100 : 0) / 100;
  if (profilePicChance > 0 && Math.random() < profilePicChance && opts.updateProfilePicEnabled) {
    onLog("Random Actions: updating profile picture…");
    await context.runUpdateProfilePicture(serial, opts.updateProfilePicFolderPath ?? "", (message: string) => onLog(`  ${message}`), {
      alterationEnabled: opts.updateProfilePicAlterationEnabled ?? true,
      alterationLevel: opts.updateProfilePicAlterationLevel ?? "small",
      imageSettingsEnabled: opts.updateProfilePicImageSettingsEnabled ?? true,
      imageSettings: opts.updateProfilePicImageSettings,
      fixAiSlop: opts.updateProfilePicFixAiSlop ?? true,
      metadataCleanup: opts.updateProfilePicMetadataCleanup ?? true,
      frequencyDisruption: opts.updateProfilePicFrequencyDisruption ?? false,
    });
    if (opts.updateProfilePicDisableAfterUsed) await mutateAfter?.("profile");
    fired = true;
  }
  const bioChance = rollRange(opts.updateBioActivatePctMin ?? 0, opts.updateBioActivatePctMax ?? 0) / 100;
  if (bioChance > 0 && Math.random() < bioChance && opts.updateBioText?.trim()) {
    onLog("Random Actions: updating profile bio…");
    await context.runUpdateBio(serial, opts.updateBioText, (message: string) => onLog(`  ${message}`));
    if (opts.updateBioDisableAfterUsed) await mutateAfter?.("bio");
    fired = true;
  }
  return fired;
}