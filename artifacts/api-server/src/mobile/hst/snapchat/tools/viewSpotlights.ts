import * as android from "../../../androidManager";
import type { SnapchatContext } from "../context";
import { openSpotlight, isSpotlightSurface } from "../navigation/openSpotlight";
import { swipeByDeviceGesture } from "../navigation/swipeByDeviceGesture";
import { dump, logAction, nodeLabel, randomCount, randomPercent, randomSeconds } from "../runtime";

export async function runViewSpotlights(context: SnapchatContext): Promise<void> {
  const settings = context.tools.viewStories;
  const isStillEnabled = async () => {
    if (!settings.enabled) return false;
    if (!context.getToolEnabled) return true;
    try {
      return await context.getToolEnabled("viewStories") === true;
    } catch {
      return false;
    }
  };
  if (!await isStillEnabled()) {
    context.onLog("View Spotlights skipped: its setting is disabled or could not be verified.");
    return;
  }
  const requested = randomCount(Math.max(1, settings.min), Math.max(1, settings.max));
  logAction(context, `View ${requested} Spotlights`);
  if (!await openSpotlight(context)) {
    logAction(context, "Spotlights not completed; could not open Spotlight");
    return;
  }

  let swiped = 0;
  let viewed = 0;
  let stopReason = "";
  let disabledDuringRun = false;
  const stopForDisabledSetting = () => {
    disabledDuringRun = true;
    stopReason = "setting switched off";
    context.onLog("View Spotlights stopped: its setting was switched off.");
  };
  for (let index = 0; index < requested && !context.isAborted(); index++) {
    if (!await isStillEnabled()) {
      stopForDisabledSetting();
      break;
    }
    const state = await dump(context.serial);
    if (!isSpotlightSurface(state.xml, state.nodes)) {
      stopReason = "Spotlight screen was unavailable";
      context.onLog("View Spotlights stopped: Spotlight was no longer the active screen.");
      break;
    }
    if (!await isStillEnabled()) {
      stopForDisabledSetting();
      break;
    }
    viewed++;
    context.onMetric?.("snapchat_spotlights");

    const likeChance = randomPercent(settings.likePercentMin, settings.likePercentMax);
    const roll = Math.random() * 100;
    if (roll < likeChance) {
      const favorite = state.nodes.find(node =>
        node.clickable && node.resourceId.split("/").pop() === "favorite",
      );
      if (!favorite) {
        context.onLog("View Spotlights: like chance passed, but the current media's heart button was not found.");
      } else if (favorite.selected || /\b(unlike|remove favorite)\b/i.test(nodeLabel(favorite))) {
        context.onLog("View Spotlights: current Spotlight media is already liked; leaving it unchanged.");
      } else if (!context.isAborted()) {
        if (!await isStillEnabled()) {
          stopForDisabledSetting();
          break;
        }
        const x = Math.round((favorite.bounds[0] + favorite.bounds[2]) / 2);
        const y = Math.round(favorite.bounds[1] + (favorite.bounds[3] - favorite.bounds[1]) * 0.37);
        await android.tap(context.serial, x, y, "bot", "Snapchat: like current Spotlight media", "automation");
        await context.sleep(500);
        context.onMetric?.("snapchat_spotlight_likes");
        context.onLog(`View Spotlights: liked current media (roll ${roll.toFixed(1)} < ${likeChance}%).`);
      }
    } else {
      context.onLog(`View Spotlights: skipped like on current media (roll ${roll.toFixed(1)} ≥ ${likeChance}%).`);
    }

    const seconds = randomSeconds(settings.watchSecondsMin, settings.watchSecondsMax);
    context.onLog(`View Spotlights: waiting ${seconds}s before the next Spotlight swipe.`);
    const watchUntil = Date.now() + seconds * 1000;
    while (!context.isAborted() && Date.now() < watchUntil) {
      await context.sleep(Math.min(1000, watchUntil - Date.now()));
      if (!await isStillEnabled()) {
        stopForDisabledSetting();
        break;
      }
    }
    if (context.isAborted() || disabledDuringRun) break;
    if (!await isStillEnabled()) {
      stopForDisabledSetting();
      break;
    }
    if (!await swipeByDeviceGesture(context)) {
      stopReason = "next Spotlight could not be opened";
      break;
    }
    const afterSwipe = await dump(context.serial);
    if (!isSpotlightSurface(afterSwipe.xml, afterSwipe.nodes)) {
      stopReason = "Spotlight screen ended";
      context.onLog("View Spotlights stopped: the screen left Spotlight after the swipe.");
      break;
    }
    swiped++;
  }
  context.onLog(disabledDuringRun
    ? `View Spotlights: stopped after its setting was switched off (${swiped}/${requested} swipe(s)).`
    : `View Spotlights: completed ${swiped}/${requested} Spotlight swipe(s).`);
  const result = disabledDuringRun
    ? `${viewed} Spotlights done; setting switched off`
    : viewed === requested
    ? `${viewed} Spotlights done`
    : `${viewed} of ${requested} Spotlights done${stopReason ? `; ${stopReason}` : context.isAborted() ? "; cycle stopped" : ""}`;
  logAction(context, result);
}
