import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode } from "../context";
import { shortResourceId } from "../runtime";

export function isSnapMediaViewer(xml: string, nodes: UiNode[]): boolean {
  return /opera_viewer/i.test(xml) &&
    nodes.some(node => shortResourceId(node) === "chrome_title") &&
    nodes.some(node =>
      shortResourceId(node) === "base_image_layer_container" ||
      /base_.*video.*layer|video.*viewer/i.test(shortResourceId(node)) ||
      /(?:SurfaceView|TextureView|VideoView)$/i.test(node.className),
    );
}

export async function exitSnapViewer(context: SnapchatContext): Promise<boolean> {
  if (context.isAborted()) return false;
  context.onLog("View Snaps: pressing Android Back once to exit the Snap viewer.");
  try {
    await android.keyevent(context.serial, 4);
    return true;
  } catch {
    context.onLog("View Snaps stopped: Android Back failed while exiting the Snap viewer.");
    return false;
  }
}
