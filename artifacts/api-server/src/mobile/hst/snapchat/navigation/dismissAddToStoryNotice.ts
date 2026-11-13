import type { SnapchatContext, UiNode, UiState } from "../context";
import { center, dump, shortResourceId, tapNode } from "../runtime";

export type AddToStoryNoticeResult = "not-present" | "dismissed" | "failed" | "aborted";

function isAddToStoryNotice(state: UiState): boolean {
  return state.nodes.some(node => {
    const text = `${node.text} ${node.desc}`.trim().replace(/\s+/g, " ").toLowerCase();
    return text === "add to your story?" ||
      (shortResourceId(node) === "alert_dialog_title" && text.includes("add to your story"));
  });
}

function findOkayControl(nodes: UiNode[]): UiNode | undefined {
  const byResourceId = nodes.find(node =>
    node.clickable && shortResourceId(node) === "add_to_story_dialog_confirm_view",
  );
  if (byResourceId) return byResourceId;

  const okayLabel = nodes.find(node =>
    [node.text, node.desc].some(value => /^(?:okay|ok)$/i.test(value.trim())),
  );
  if (!okayLabel || okayLabel.clickable) return okayLabel;

  const point = center(okayLabel);
  return nodes
    .filter(node => {
      const [left, top, right, bottom] = node.bounds;
      return node.clickable &&
        point.x >= left && point.x <= right &&
        point.y >= top && point.y <= bottom;
    })
    .sort((a, b) =>
      (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) -
      (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]),
    )[0];
}

/**
 * Snapchat can show an "Add To Your Story?" confirmation after audience
 * selection. The confirmation control may have no accessible text, so use its
 * live resource ID; never confuse it with the separate Cancel control.
 */
export async function dismissAddToStoryNotice(
  context: SnapchatContext,
  initialState: UiState,
): Promise<AddToStoryNoticeResult> {
  const deadline = Date.now() + 1_800;
  let state = initialState;
  let noticeSeen = false;
  let missingOkayLogged = false;
  let tapAttempts = 0;

  while (!context.isAborted() && Date.now() < deadline) {
    if (isAddToStoryNotice(state)) {
      noticeSeen = true;
      const okay = findOkayControl(state.nodes);
      if (!okay) {
        if (!missingOkayLogged) {
          context.onLog("Snapchat upload: Add To Your Story confirmation is visible, but its Okay control is not available yet.");
          missingOkayLogged = true;
        }
      } else {
        const point = center(okay);
        context.onLog(`Snapchat upload: Add To Your Story confirmation found; tapping Okay at (${point.x},${point.y}).`);
        try {
          if (!await tapNode(context, okay, "confirm Add To Your Story notice", 0, true)) {
            return "aborted";
          }
        } catch (error) {
          context.onLog(
            `Snapchat upload: could not tap Okay on Add To Your Story confirmation (${error instanceof Error ? error.message : String(error)}).`,
          );
          return "failed";
        }
        tapAttempts++;
        await context.sleep(350, "exact");
        if (context.isAborted()) return "aborted";
        state = await dump(context.serial);
        if (!isAddToStoryNotice(state)) {
          context.onLog("Snapchat upload: Add To Your Story confirmation cleared; continuing.");
          return "dismissed";
        }
        if (tapAttempts >= 2) {
          context.onLog("Snapchat upload stopped: Add To Your Story confirmation remained after tapping Okay twice.");
          return "failed";
        }
        context.onLog("Snapchat upload: confirmation remained visible; retrying its Okay control once.");
        continue;
      }
    }

    await context.sleep(250, "exact");
    if (context.isAborted()) return "aborted";
    state = await dump(context.serial);
  }

  if (context.isAborted()) return "aborted";
  if (noticeSeen) {
    context.onLog("Snapchat upload stopped: Add To Your Story confirmation appeared without an actionable Okay control.");
    return "failed";
  }
  return "not-present";
}
