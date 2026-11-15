import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode, UiState } from "../context";

const normalizeLabel = (value: string) =>
  value.trim().replace(/\s+/g, " ").replace(/[‐‑‒–—]/g, "-").toLowerCase();

const isSmallerInFeedAds = (value: string) =>
  /^smaller in-feed ads?$/.test(normalizeLabel(value));

const isLargerBannerAds = (value: string) =>
  /^larger banner ads?$/.test(normalizeLabel(value));

export function isAdExperiencePrompt(state: UiState): boolean {
  const labels = state.nodes.flatMap(node => [node.text, node.desc])
    .map(normalizeLabel)
    .filter(Boolean);
  return labels.some(label => label === "choose your ad experience") &&
    labels.some(isSmallerInFeedAds) &&
    labels.some(isLargerBannerAds);
}

function findSmallerInFeedAdsTarget(nodes: UiNode[]): UiNode | undefined {
  const labelNode = nodes.find(node =>
    [node.text, node.desc].some(isSmallerInFeedAds),
  );
  if (!labelNode || labelNode.clickable) return labelNode;

  const [left, top, right, bottom] = labelNode.bounds;
  const x = Math.round((left + right) / 2);
  const y = Math.round((top + bottom) / 2);
  const labelArea = Math.max(1, right - left) * Math.max(1, bottom - top);
  const clickableParent = nodes
    .filter(node =>
      node.clickable &&
      x >= node.bounds[0] && x <= node.bounds[2] &&
      y >= node.bounds[1] && y <= node.bounds[3] &&
      Math.max(1, node.bounds[2] - node.bounds[0]) *
        Math.max(1, node.bounds[3] - node.bounds[1]) <= labelArea * 40,
    )
    .sort((a, b) =>
      (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) -
      (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]),
    )[0];
  return clickableParent ?? labelNode;
}

/**
 * Uses an already-requested Snapchat UI tree. Only when the exact ad-choice
 * dialog is present does it refresh under the device input lock and choose
 * the user's requested "Smaller In-Feed Ads" option.
 */
export async function dismissAdExperiencePrompt(
  context: SnapchatContext,
  initialState: UiState,
  readFreshState: () => Promise<UiState>,
): Promise<UiState> {
  if (!isAdExperiencePrompt(initialState) || context.isAborted()) return initialState;

  context.onLog("Snapchat: ad-experience prompt detected; selecting Smaller In-Feed Ads.");
  try {
    return await android.withInputTransaction(context.serial, async () => {
      if (context.isAborted()) return initialState;

      const liveState = await readFreshState();
      if (!isAdExperiencePrompt(liveState)) return liveState;

      const target = findSmallerInFeedAdsTarget(liveState.nodes);
      if (!target) {
        context.onLog("Snapchat: ad-experience prompt is visible, but its Smaller In-Feed Ads control was not found.");
        return liveState;
      }

      const x = Math.round((target.bounds[0] + target.bounds[2]) / 2);
      const y = Math.round((target.bounds[1] + target.bounds[3]) / 2);
      context.onLog(`Snapchat: tapping Smaller In-Feed Ads at (${x},${y}) from the live accessibility node.`);
      await android.tap(
        context.serial,
        x,
        y,
        "bot",
        "Snapchat: choose Smaller In-Feed Ads",
        "automation",
        { exact: true },
      );
      await context.sleep(350, "exact");

      const clearedState = await readFreshState();
      if (isAdExperiencePrompt(clearedState)) {
        context.onLog("Snapchat: the ad-experience prompt remains visible after choosing Smaller In-Feed Ads.");
      } else {
        context.onLog("Snapchat: Smaller In-Feed Ads selected; prompt cleared.");
      }
      return clearedState;
    });
  } catch (error) {
    context.onLog(
      `Snapchat: could not select Smaller In-Feed Ads (${error instanceof Error ? error.message : String(error)}).`,
    );
    return initialState;
  }
}
