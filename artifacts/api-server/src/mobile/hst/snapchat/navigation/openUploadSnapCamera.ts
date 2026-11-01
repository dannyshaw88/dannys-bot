import type { SnapchatContext, UiState } from "../context";
import { center, dump, shortResourceId, tapNode } from "../runtime";

function isCameraReady(state: UiState): boolean {
  return /id="camera_page"/i.test(state.xml) &&
    state.nodes.some(node => shortResourceId(node) === "camera_capture_button");
}

export async function openUploadSnapCamera(context: SnapchatContext): Promise<UiState | null> {
  let state = await dump(context.serial);
  if (isCameraReady(state)) return state;

  if (!/id="camera_page"/i.test(state.xml)) {
    const cameraTab = state.nodes.find(node =>
      node.clickable && shortResourceId(node) === "ngs_camera_icon_container",
    );
    if (!cameraTab) {
      context.onLog("Upload a Snap stopped: Snapchat's Camera tab was not exposed on the current screen.");
      return null;
    }
    const { x, y } = center(cameraTab);
    context.onLog(`Upload a Snap: tapping the Camera tab at (${x},${y}) before opening Memories.`);
    if (!await tapNode(context, cameraTab, "open Camera before Upload a Snap", 0, true)) return null;
  } else {
    context.onLog("Upload a Snap: Camera is open; waiting for its shutter control.");
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    state = await dump(context.serial);
    if (isCameraReady(state)) return state;
    if (attempt < 9) await context.sleep(500, "exact");
  }

  context.onLog("Upload a Snap stopped: Snapchat's Camera screen did not expose its shutter after navigation.");
  return null;
}
