import type { SnapchatContext, UiNode } from "../context";
import { dump, shortResourceId, tapNode } from "../runtime";

export function isStoriesListSurface(nodes: UiNode[]): boolean {
  const friendsIndex = nodes.findIndex(node =>
    [node.text, node.desc].some(value => /^friends$/i.test(value.trim())),
  );
  const discoverIndex = nodes.findIndex((node, index) =>
    index > friendsIndex && [node.text, node.desc].some(value => /^discover$/i.test(value.trim())),
  );
  return friendsIndex >= 0 && discoverIndex > friendsIndex &&
    nodes.slice(friendsIndex + 1, discoverIndex).some(node =>
      node.text.trim().toLowerCase() === "friend_story_circle_thumbnail",
    );
}

export function findStoryCircles(nodes: UiNode[], screenHeight: number): UiNode[] {
  const friendsIndex = nodes.findIndex(node =>
    [node.text, node.desc].some(value => /^friends$/i.test(value.trim())),
  );
  if (friendsIndex < 0) return [];
  const discoverIndex = nodes.findIndex((node, index) =>
    index > friendsIndex &&
    [node.text, node.desc].some(value => /^discover$/i.test(value.trim())),
  );
  if (discoverIndex < 0) return [];
  return nodes.slice(friendsIndex + 1, discoverIndex).filter(node =>
    node.text.trim().toLowerCase() === "friend_story_circle_thumbnail" &&
    node.bounds[3] < screenHeight * 0.9,
  );
}

export async function openStoriesList(context: SnapchatContext): Promise<boolean> {
  let state = await dump(context.serial);
  if (isStoriesListSurface(state.nodes)) return true;
  const storiesButton = state.nodes.find(node =>
    node.clickable && shortResourceId(node) === "ngs_community_icon_container",
  );
  if (!storiesButton) {
    context.onLog("View Snaps stopped: Snapchat's Stories tab was not found.");
    return false;
  }
  if (!await tapNode(context, storiesButton, "open Stories from the bottom navigation")) return false;
  state = await dump(context.serial);
  if (!isStoriesListSurface(state.nodes)) {
    context.onLog("View Snaps stopped: the Stories list and circular friend stories were not confirmed.");
    return false;
  }
  return true;
}
