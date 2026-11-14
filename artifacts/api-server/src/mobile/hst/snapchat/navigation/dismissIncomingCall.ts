import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode, UiState } from "../context";

const normalizeLabel = (value: string) =>
  value.trim().replace(/\s+/g, " ").toLowerCase();

function labelsOf(state: UiState): string[] {
  return state.nodes.flatMap(node => [node.text, node.desc])
    .map(normalizeLabel)
    .filter(Boolean);
}

export function isSnapchatIncomingCall(state: UiState): boolean {
  const labels = labelsOf(state);
  const visibleText = labels.join(" ");
  const hasIncomingCallTitle =
    /\bincoming\s+(?:(?:audio|video)\s+)?call\b/.test(visibleText);
  const hasJoin = labels.some(label => /^join(?:\s+call)?$/.test(label));
  const hasNotNow = labels.some(label => label === "not now");
  return hasIncomingCallTitle && hasJoin && hasNotNow;
}

function findNotNowTarget(nodes: UiNode[]): UiNode | undefined {
  const labelNode = nodes.find(node =>
    [node.text, node.desc].some(value => normalizeLabel(value) === "not now"),
  );
  if (!labelNode) return undefined;
  if (labelNode.clickable) return labelNode;

  const [left, top, right, bottom] = labelNode.bounds;
  const x = Math.round((left + right) / 2);
  const y = Math.round((top + bottom) / 2);
  return nodes
    .filter(node =>
      node.clickable &&
      x >= node.bounds[0] && x <= node.bounds[2] &&
      y >= node.bounds[1] && y <= node.bounds[3],
    )
    .sort((a, b) =>
      (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) -
      (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]),
    )[0] ?? labelNode;
}

/**
 * Reuses a UI tree the Snapchat flow already needed. Only when the distinctive
 * incoming-call prompt is present does it take a fresh tree and decline the
 * call; ordinary screen reads do not cause extra ADB work.
 */
export async function dismissIncomingCallIfPresent(
  context: SnapchatContext,
  initialState: UiState,
  readFreshState: () => Promise<UiState>,
): Promise<UiState> {
  if (!isSnapchatIncomingCall(initialState) || context.isAborted()) return initialState;

  context.onLog("Snapchat: incoming call prompt detected; declining with Not Now (Join is never tapped).");
  try {
    return await android.withInputTransaction(context.serial, async () => {
      if (context.isAborted()) return initialState;

      // Re-read under the device input lock so a stale popup cannot make us
      // tap a control that has since changed.
      const liveState = await readFreshState();
      if (!isSnapchatIncomingCall(liveState)) return liveState;

      const target = findNotNowTarget(liveState.nodes);
      if (!target) {
        context.onLog("Snapchat: incoming call prompt is visible, but its live Not Now control was not found; no call action was taken.");
        return liveState;
      }

      const x = Math.round((target.bounds[0] + target.bounds[2]) / 2);
      const y = Math.round((target.bounds[1] + target.bounds[3]) / 2);
      context.onLog(`Snapchat: tapping the live Not Now control at (${x},${y}); never accepting the call.`);
      await android.tap(
        context.serial,
        x,
        y,
        "bot",
        "Snapchat: decline incoming call with Not Now",
        "automation",
        { exact: true },
      );
      await context.sleep(350, "exact");
      context.onLog("Snapchat: tapped Not Now on the incoming call prompt; continuing the current flow.");

      // Return the current screen to the caller. This read is only needed after
      // the rare prompt is actually found and handled.
      return context.isAborted() ? liveState : await readFreshState();
    });
  } catch (error) {
    context.onLog(
      `Snapchat: could not dismiss the incoming call prompt (${error instanceof Error ? error.message : String(error)}); continuing without accepting it.`,
    );
    return initialState;
  }
}
