import * as android from "../../../androidManager";
import type { SnapchatContext } from "../context";
import { exitSnapViewer } from "../navigation/exitSnapViewer";
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

  await context.sleep(700, "exact");
  let viewed = 1;
  context.onMetric?.("snapchat_snaps");
  for (let index = 1; index < requested && !context.isAborted(); index++) {
    const seconds = randomSeconds(settings.watchSecondsMin, settings.watchSecondsMax);
    context.onLog(`View Snaps: waiting ${seconds}s before the next Snap tap.`);
    await context.sleep(seconds * 1000);
    if (context.isAborted()) break;

    const x = Math.max(0, Math.round(screenWidth - 50));
    const y = Math.round(screenHeight * 0.5);
    context.onLog(`View Snaps: exact next-Snap tap at (${x},${y}) on ${screenWidth}×${screenHeight}.`);
    await android.tap(
      context.serial,
      x,
      y,
      "bot",
      "Snapchat: advance to next Snap on right side",
      "automation",
      { exact: true },
    );
    await context.sleep(700, "exact");
    viewed++;
    context.onMetric?.("snapchat_snaps");
  }
  if (!context.isAborted()) await exitSnapViewer(context);
  context.onLog(`View Snaps: viewed ${viewed}/${requested} Snap(s).`);
}
