import type { SnapchatContext, UiNode, UiState } from "../context";
import { dump, tapNode } from "../runtime";

function isSnapchatNotificationPermissionDialog(state: UiState): boolean {
  const visibleText = state.nodes
    .map(node => `${node.text} ${node.desc}`)
    .join(" ")
    .replace(/[‘’]/g, "'")
    .toLowerCase();
  return visibleText.includes("snapchat") &&
    /requesting permission to send you notifications/.test(visibleText);
}

function findDontAllowButton(nodes: UiNode[]): UiNode | undefined {
  return nodes.find(node =>
    [node.text, node.desc].some(value =>
      value.trim().replace(/[‘’]/g, "'").toLowerCase() === "don't allow",
    ),
  );
}

/**
 * Snapchat can show Android's notification permission sheet on first launch.
 * Clear that exact dialog before any Camera/banner navigation checks.
 */
export async function dismissSnapchatNotificationPermission(
  context: SnapchatContext,
): Promise<boolean> {
  const deadline = Date.now() + 3_000;
  let state = await dump(context.serial);
  while (
    !isSnapchatNotificationPermissionDialog(state) &&
    !context.isAborted() &&
    Date.now() < deadline
  ) {
    await context.sleep(300, "exact");
    if (context.isAborted()) return false;
    state = await dump(context.serial);
  }

  if (!isSnapchatNotificationPermissionDialog(state)) return !context.isAborted();

  for (let attempt = 1; attempt <= 2 && !context.isAborted(); attempt++) {
    const denyButton = findDontAllowButton(state.nodes);
    if (!denyButton) {
      context.onLog(
        "Snapchat startup: notification permission dialog is present, but its live Don't allow control was not found.",
      );
      return false;
    }

    context.onLog(
      `Snapchat startup: notification permission dialog found; tapping Don't allow before account and banner checks (attempt ${attempt}).`,
    );
    if (!await tapNode(context, denyButton, "deny Snapchat notification permission", 500, true)) {
      return false;
    }

    state = await dump(context.serial);
    if (!isSnapchatNotificationPermissionDialog(state)) {
      context.onLog("Snapchat startup: notification permission dialog dismissed.");
      return true;
    }
  }

  context.onLog(
    "Snapchat startup: notification permission dialog remained after tapping Don't allow; stopping before other navigation checks.",
  );
  return false;
}
