import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode } from "../context";
import { dump, nodeLabel, shortResourceId, tapNode } from "../runtime";

export const FRIEND_REQUEST_COOLDOWN_MS = 3 * 60 * 60 * 1000;

export function isFriendRequestLimitDialog(nodes: UiNode[]): boolean {
  const hasTitle = nodes.some(node =>
    /^slow\s+down!?$/i.test(node.text.trim()) ||
    /^slow\s+down!?$/i.test(node.desc.trim()),
  );
  const hasLimitMessage = nodes.some(node =>
    /reached your limit of friend requests/i.test(`${node.text} ${node.desc}`),
  );
  return hasTitle && hasLimitMessage;
}

export function formatCooldownTime(timestamp: number): string {
  const date = new Date(timestamp);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}-${two(date.getDate())}/${two(date.getMonth() + 1)}/${date.getFullYear()}`;
}

export async function handleFriendRequestLimit(
  context: SnapchatContext,
  toolName: "Add Friends" | "Accept Friends",
  nodes: UiNode[],
): Promise<false | "friend-request-cooldown" | "friend-request-cooldown-blocked"> {
  if (!isFriendRequestLimitDialog(nodes)) return false;

  const until = Date.now() + FRIEND_REQUEST_COOLDOWN_MS;
  context.onLog(
    `Snapchat friend-request limit reached. Add Friends and Accept Friends are paused for 3 hours, until ${formatCooldownTime(until)}.`,
  );
  try {
    await context.onFriendRequestCooldown?.(until, toolName);
  } catch (error) {
    context.onLog(`Snapchat friend-request cooldown could not be saved: ${error instanceof Error ? error.message : "storage error"}.`);
  }

  const okButton = nodes.find(node =>
    shortResourceId(node) === "composer_alert_confirm" &&
    (node.clickable || /^(?:ok|okay)$/i.test(nodeLabel(node))),
  );
  if (!okButton) {
    context.onLog("Snapchat friend-request limit: the live OK button was not found; stopping friend tools without tapping elsewhere.");
    return "friend-request-cooldown-blocked";
  }

  context.onLog("Snapchat friend-request limit: tapping OK, then pressing Android Back once.");
  if (!await tapNode(context, okButton, "dismiss Snapchat's friend-request limit with OK", 450)) {
    context.onLog("Snapchat friend-request limit: OK could not be confirmed; no extra navigation tap was sent.");
    return "friend-request-cooldown-blocked";
  }

  const afterOk = await dump(context.serial);
  if (isFriendRequestLimitDialog(afterOk.nodes)) {
    context.onLog("Snapchat friend-request limit: the warning remained after OK; Android Back was not sent.");
    return "friend-request-cooldown-blocked";
  }

  try {
    await android.keyevent(context.serial, 4);
    await context.sleep(250, "exact");
    context.onLog("Snapchat friend-request limit: dismissed with OK and sent Android Back once.");
  } catch (error) {
    context.onLog(`Snapchat friend-request limit: Android Back failed after OK (${error instanceof Error ? error.message : "unknown error"}).`);
    return "friend-request-cooldown-blocked";
  }
  return "friend-request-cooldown";
}
