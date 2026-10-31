import type { SnapchatContext } from "../context";
import { dump, shortResourceId, tapNode } from "../runtime";

export async function returnToCameraBeforeNextTool(context: SnapchatContext): Promise<boolean> {
  const state = await dump(context.serial);
  if (/camera_page/i.test(state.xml)) return true;
  const cameraButton = state.nodes.find(node =>
    node.clickable && shortResourceId(node) === "ngs_camera_icon_container",
  );
  if (!cameraButton) {
    context.onLog("Snapchat stopped before the next tool: the Camera tab was not available to restore the starting surface.");
    return false;
  }
  if (!await tapNode(context, cameraButton, "return to Camera before the next tool")) return false;
  const after = await dump(context.serial);
  if (!/camera_page/i.test(after.xml)) {
    context.onLog("Snapchat stopped before the next tool: the Camera screen was not confirmed.");
    return false;
  }
  return true;
}
