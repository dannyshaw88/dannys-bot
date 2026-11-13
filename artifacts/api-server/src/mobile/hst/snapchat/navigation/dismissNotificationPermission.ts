import type { SnapchatContext, UiNode, UiState } from "../context";
import * as android from "../../../androidManager";
import { dump, tapNode } from "../runtime";

function isSnapchatNotificationPermissionDialog(state: UiState): boolean {
  const visibleText = state.nodes
    .map(node => `${node.text} ${node.desc}`)
    .join(" ")
    .replace(/[‘’]/g, "'")
    .toLowerCase();
  return visibleText.includes("snapchat") &&
    /notifications?/.test(visibleText) &&
    /requesting permission|permission.{0,80}notifications?|notifications?.{0,80}permission|allow.{0,40}notifications?|send.{0,40}notifications?/i
      .test(visibleText);
}

function isNotificationDenyLabel(value: string): boolean {
  return value.trim()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .match(/^(?:don't allow(?: notifications)?|deny(?: all)?(?: notifications?)?)$/) !== null;
}

function findNotificationDenyButton(nodes: UiNode[]): UiNode | undefined {
  const matchingLabels = nodes.filter(node =>
    [node.text, node.desc].some(isNotificationDenyLabel),
  );
  const area = (node: UiNode) =>
    Math.max(0, node.bounds[2] - node.bounds[0]) *
    Math.max(0, node.bounds[3] - node.bounds[1]);
  matchingLabels.sort((a, b) =>
    Number(b.clickable) - Number(a.clickable) || area(b) - area(a),
  );
  const labelNode = matchingLabels[0];
  if (!labelNode || labelNode.clickable) return labelNode;

  const [left, top, right, bottom] = labelNode.bounds;
  const x = Math.round((left + right) / 2);
  const y = Math.round((top + bottom) / 2);
  const clickableParent = nodes
    .filter(node =>
      node.clickable &&
      x >= node.bounds[0] && x <= node.bounds[2] &&
      y >= node.bounds[1] && y <= node.bounds[3],
    )
    .sort((a, b) => area(a) - area(b))[0];
  return clickableParent ?? labelNode;
}

export type SnapchatStartupPopupTapResult =
  | "not-present"
  | "tapped"
  | "button-missing"
  | "aborted";

function isVerifyEmailAccountPopup(state: UiState): boolean {
  const visibleText = state.nodes
    .map(node => `${node.text} ${node.desc}`)
    .join(" ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return /verify\s+(?:your\s+)?email(?:\s+account)?/.test(visibleText);
}

async function dismissVerifyEmailAccountPopup(
  context: SnapchatContext,
): Promise<"tapped" | "aborted"> {
  const { w, h } = android.getScreenSize(context.serial);
  const centerX = Math.round(w / 2);
  const centerY = Math.round(h / 2);
  context.onLog(
    `Snapchat startup: Verify email account popup found; tapping its center (${centerX}, ${centerY}) and swiping down.`,
  );
  try {
    await android.tap(
      context.serial,
      centerX,
      centerY,
      "bot",
      "dismiss Snapchat Verify email account popup",
      "automation",
      { exact: true },
    );
    if (context.isAborted()) return "aborted";
    await context.sleep(150, "exact");
    if (context.isAborted()) return "aborted";
    await android.swipe(
      context.serial,
      centerX,
      centerY,
      centerX,
      Math.round(h * 0.82),
      450,
      false,
    );
  } catch (error) {
    context.onLog(
      `Snapchat startup: could not dismiss Verify email account popup (${error instanceof Error ? error.message : String(error)}).`,
    );
    return "aborted";
  }
  context.onLog("Snapchat startup: tapped and swiped down on Verify email account popup; continuing.");
  return context.isAborted() ? "aborted" : "tapped";
}

/**
 * Handles either startup popup using a caller's already-fresh UI tree.
 * Snapchat presents the notification dialog and Verify email popup separately.
 */
export async function tapSnapchatStartupPopupIfPresent(
  context: SnapchatContext,
  state: UiState,
): Promise<SnapchatStartupPopupTapResult> {
  if (context.isAborted()) return "aborted";

  if (isSnapchatNotificationPermissionDialog(state)) {
    const denyButton = findNotificationDenyButton(state.nodes);
    if (!denyButton) return "button-missing";

    const buttonLabel = [denyButton.text, denyButton.desc]
      .map(value => value.trim())
      .find(Boolean) ?? "Deny";
    context.onLog(
      `Snapchat startup: notification permission dialog found; tapping its "${buttonLabel}" denial button before account and banner checks.`,
    );
    if (!await tapNode(context, denyButton, "deny Snapchat notification permission", 0, true)) {
      return "aborted";
    }
    context.onLog(`Snapchat startup: tapped "${buttonLabel}"; continuing.`);
    return "tapped";
  }

  if (isVerifyEmailAccountPopup(state)) {
    return dismissVerifyEmailAccountPopup(context);
  }

  return "not-present";
}

/**
 * Snapchat may show either the Android notification dialog or its Verify email
 * account popup on launch. Clear the one present before Camera/banner checks.
 */
export async function dismissSnapchatStartupPopup(
  context: SnapchatContext,
): Promise<"tapped" | "not-found" | "aborted"> {
  const deadline = Date.now() + 3_000;
  let state = await dump(context.serial);
  let missingButtonLogged = false;
  while (
    !context.isAborted() &&
    Date.now() < deadline
  ) {
    const result = await tapSnapchatStartupPopupIfPresent(context, state);
    if (result === "tapped") return "tapped";
    if (result === "aborted") return "aborted";
    if (result === "button-missing" && !missingButtonLogged) {
      context.onLog(
        "Snapchat startup: notification permission dialog is present; waiting for its Deny/Don't allow button to appear.",
      );
      missingButtonLogged = true;
    }
    await context.sleep(300, "exact");
    if (context.isAborted()) return "aborted";
    state = await dump(context.serial);
  }

  return context.isAborted() ? "aborted" : "not-found";
}
