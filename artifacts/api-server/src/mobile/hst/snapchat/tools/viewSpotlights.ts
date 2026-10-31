import * as android from "../../../androidManager";
import type { SnapchatContext } from "../context";
import { openSpotlight, isSpotlightSurface } from "../navigation/openSpotlight";
import { swipeByDeviceGesture } from "../navigation/swipeByDeviceGesture";
import { dump, nodeLabel, randomCount, randomPercent, randomSeconds } from "../runtime";

export async function runViewSpotlights(context: SnapchatContext): Promise<void> {
  const settings = context.tools.viewStories;
  if (!settings.enabled) return;
  const requested = randomCount(Math.max(1, settings.min), Math.max(1, settings.max));
  if (!await openSpotlight(context)) return;

  let swiped = 0;
  for (let index = 0; index < requested && !context.isAborted(); index++) {
    const state = await dump(context.serial);
    if (!isSpotlightSurface(state.xml, state.nodes)) {
      context.onLog("View Spotlights stopped: Spotlight was no longer the active screen.");
      break;
    }
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
        const x = Math.round((favorite.bounds[0] + favorite.bounds[2]) / 2);
        const y = Math.round(favorite.bounds[1] + (favorite.bounds[3] - favorite.bounds[1]) * 0.37);
        await android.tap(context.serial, x, y, "bot", "Snapchat: like current Spotlight media", "automation");
        await context.sleep(500);
        context.onLog(`View Spotlights: liked current media (roll ${roll.toFixed(1)} < ${likeChance}%).`);
      }
    } else {
      context.onLog(`View Spotlights: skipped like on current media (roll ${roll.toFixed(1)} ≥ ${likeChance}%).`);
    }

    const seconds = randomSeconds(settings.watchSecondsMin, settings.watchSecondsMax);
    context.onLog(`View Spotlights: waiting ${seconds}s before the next Spotlight swipe.`);
    await context.sleep(seconds * 1000);
    if (context.isAborted() || !await swipeByDeviceGesture(context)) break;
    const afterSwipe = await dump(context.serial);
    if (!isSpotlightSurface(afterSwipe.xml, afterSwipe.nodes)) {
      context.onLog("View Spotlights stopped: the screen left Spotlight after the swipe.");
      break;
    }
    swiped++;
  }
  context.onLog(`View Spotlights: completed ${swiped}/${requested} Spotlight swipe(s).`);
}
