import type { SnapchatContext, UiNode } from "../context";
import { dump, shortResourceId, tapNode } from "../runtime";

export function isSpotlightSurface(xml: string, nodes: UiNode[]): boolean {
  return /spotlight_container/i.test(xml) &&
    nodes.some(node => node.text.trim().toLowerCase() === "spotlight" && node.bounds[1] < 400);
}

export async function openSpotlight(context: SnapchatContext): Promise<boolean> {
  const { nodes } = await dump(context.serial);
  const button = nodes.find(node =>
    node.clickable && shortResourceId(node) === "ngs_spotlight_icon_container",
  );
  if (!button) {
    context.onLog("View Spotlights stopped: Spotlight button was not found in Snapchat's bottom navigation.");
    return false;
  }
  if (!await tapNode(context, button, "open Spotlight from the bottom navigation")) return false;
  const state = await dump(context.serial);
  if (!isSpotlightSurface(state.xml, state.nodes)) {
    context.onLog("View Spotlights stopped: the Spotlight screen could not be confirmed after tapping its navigation icon.");
    return false;
  }
  return true;
}
