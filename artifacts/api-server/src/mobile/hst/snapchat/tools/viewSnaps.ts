import * as android from "../../../androidManager";
import type { SnapchatContext } from "../context";
import { exitSnapViewer, isSnapMediaViewer } from "../navigation/exitSnapViewer";
import { findStoryCircles, openStoriesList } from "../navigation/openStoriesList";
import { dump, randomCount, randomSeconds, tapNode } from "../runtime";

export async function runViewSnaps(context: SnapchatContext): Promise<void> {
  const settings = context.tools.viewSnaps;
  if (!settings.enabled) return;
  const requested = randomCount(Math.max(1, settings.min), Math.max(1, settings.max));
  if (!await openStoriesList(context)) return;

  const stories = await dump(context.serial);
  const { h: screenHeight, w: screenWidth } = await android.getScreenSizeAsync(context.serial);
  const circles = findStoryCircles(stories.nodes, screenHeight);
  if (circles.length === 0) {
    context.onLog("View Snaps stopped: no circular stories were found under Friends.");
    return;
  }
  const story = circles[Math.floor(Math.random() * circles.length)];
  if (!await tapNode(context, story, "open a circular story")) return;

  let state = await dump(context.serial);
  if (!isSnapMediaViewer(state.xml, state.nodes)) {
    context.onLog("View Snaps stopped: Snapchat's story viewer was not confirmed after opening a story.");
    return;
  }

  let viewed = 1;
  context.onMetric?.("snapchat_snaps");
  for (let index = 1; index < requested && !context.isAborted(); index++) {
    const seconds = randomSeconds(settings.watchSecondsMin, settings.watchSecondsMax);
    context.onLog(`View Snaps: waiting ${seconds}s before the next Snap tap.`);
    await context.sleep(seconds * 1000);
    if (context.isAborted()) break;

    state = await dump(context.serial);
    if (!isSnapMediaViewer(state.xml, state.nodes)) {
      context.onLog("View Snaps stopped: the Snapchat story viewer was no longer active.");
      break;
    }
    const x = Math.round(screenWidth * 0.86);
    const y = Math.round(screenHeight * 0.5);
    await android.tap(context.serial, x, y, "bot", "Snapchat: advance to next Snap on right side", "automation");
    await context.sleep(700);
    state = await dump(context.serial);
    if (!isSnapMediaViewer(state.xml, state.nodes)) {
      context.onLog("View Snaps stopped: the story viewer closed after the right-side tap.");
      break;
    }
    viewed++;
    context.onMetric?.("snapchat_snaps");
  }
  if (!context.isAborted() && isSnapMediaViewer(state.xml, state.nodes)) {
    await exitSnapViewer(context);
  }
  context.onLog(`View Snaps: viewed ${viewed}/${requested} Snap(s).`);
}
