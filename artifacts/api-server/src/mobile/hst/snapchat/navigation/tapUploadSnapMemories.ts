import type { SnapchatContext, UiNode } from "../context";
import { center, shortResourceId, tapNode } from "../runtime";

export async function tapUploadSnapMemories(
  context: SnapchatContext,
  nodes: UiNode[],
): Promise<boolean> {
  const shutter = nodes.find(node =>
    shortResourceId(node) === "camera_capture_button" &&
    node.desc.trim().toLowerCase() === "camera capture",
  );
  if (!shutter) {
    context.onLog("Upload a Snap: Camera shutter was not exposed; no other navigation control was tapped.");
    return false;
  }

  const shutterCenter = center(shutter);
  const memoriesIcon = nodes.find(node => {
    const label = node.desc.trim().toLowerCase();
    const matchesMemories = shortResourceId(node) === "ngs_memories_icon" || label === "memories";
    const boundsValid = node.bounds[2] > node.bounds[0] && node.bounds[3] > node.bounds[1];
    const isLeftOfShutter = node.bounds[2] < shutter.bounds[0];
    const alignedWithShutter = center(node).y >= shutter.bounds[1] && center(node).y <= shutter.bounds[3];
    return matchesMemories && boundsValid && isLeftOfShutter && alignedWithShutter;
  });
  if (!memoriesIcon) {
    context.onLog("Upload a Snap: the live Memories icon left of the Camera shutter was not found; no other navigation control was tapped.");
    return false;
  }

  const target = center(memoriesIcon);
  context.onLog(
    `Upload a Snap: tapping Memories at (${target.x},${target.y}), left of the Camera shutter at (${shutterCenter.x},${shutterCenter.y}).`,
  );
  return tapNode(context, memoriesIcon, "open Memories from its icon left of the Camera shutter", 0, true);
}
