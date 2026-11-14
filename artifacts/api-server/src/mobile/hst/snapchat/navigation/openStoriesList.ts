import type { SnapchatContext, UiNode } from "../context";
import { dump, shortResourceId, tapNode } from "../runtime";

export function isStoriesListSurface(nodes: UiNode[]): boolean {
  const friendsIndex = nodes.findIndex(node =>
    [node.text, node.desc].some(value => /^friends$/i.test(value.trim())),
  );
  const discoverIndex = nodes.findIndex((node, index) =>
    index > friendsIndex && [node.text, node.desc].some(value => /^discover$/i.test(value.trim())),
  );
  return friendsIndex >= 0 && discoverIndex > friendsIndex;
}

type StoryCircleScan = {
  circles: UiNode[];
  replayCount: number;
  addFriendCount: number;
};

const nodeWords = (node: UiNode) =>
  [node.text, node.desc, node.resourceId, shortResourceId(node)]
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function overlapsStoryCard(marker: UiNode, story: UiNode): boolean {
  if (marker === story) return false;
  const [leftA, topA, rightA, bottomA] = marker.bounds;
  const [leftB, topB, rightB, bottomB] = story.bounds;
  const intersectionWidth = Math.max(0, Math.min(rightA, rightB) - Math.max(leftA, leftB));
  const intersectionHeight = Math.max(0, Math.min(bottomA, bottomB) - Math.max(topA, topB));
  const intersectionArea = intersectionWidth * intersectionHeight;
  const smallerArea = Math.min(
    Math.max(1, (rightA - leftA) * (bottomA - topA)),
    Math.max(1, (rightB - leftB) * (bottomB - topB)),
  );
  return intersectionArea / smallerArea >= 0.65;
}

function isReplayMarker(node: UiNode): boolean {
  const words = nodeWords(node);
  return words.includes("avatar story replay") ||
    /\b(replay|watch again|refresh story|story refresh)\b/.test(words);
}

function isAddPersonMarker(node: UiNode): boolean {
  const words = nodeWords(node);
  if (words.includes("feed plus badge icon")) return true;
  return /\b(avatar story (add|plus)|friend story (add|plus)|add friends?|friends? add|add persons?|persons? add|add users?|users? add|friend suggestions?|suggested friends?)\b/.test(words) ||
    (/\b(plus|add)\b/.test(words) && /\b(person|people|human|user|friends?|profile|man)\b/.test(words));
}

function hasSeparatePlusAndPersonMarkers(markers: UiNode[]): boolean {
  const words = markers.map(nodeWords);
  return words.some((label, index) =>
    /\b(plus|add)\b/.test(label) &&
    words.some((other, otherIndex) =>
      otherIndex !== index && /\b(person|people|human|user|friends?|profile|man)\b/.test(other),
    ),
  );
}

export function scanFreshStoryCircles(nodes: UiNode[], screenHeight: number): StoryCircleScan {
  const friendsIndex = nodes.findIndex(node =>
    [node.text, node.desc].some(value => /^friends$/i.test(value.trim())),
  );
  const discoverIndex = nodes.findIndex((node, index) =>
    index > friendsIndex && [node.text, node.desc].some(value => /^discover$/i.test(value.trim())),
  );
  if (friendsIndex < 0 || discoverIndex < 0) {
    return { circles: [], replayCount: 0, addFriendCount: 0 };
  }

  const rowNodes = nodes.slice(friendsIndex + 1, discoverIndex);
  const storyNodes = rowNodes.filter(node =>
    node.text.trim().toLowerCase() === "friend_story_circle_thumbnail" &&
    node.bounds[3] < screenHeight * 0.9,
  );
  let replayCount = 0;
  let addFriendCount = 0;
  const circles = storyNodes.filter(story => {
    const markers = rowNodes.filter(node => overlapsStoryCard(node, story));
    if (markers.some(isReplayMarker)) {
      replayCount++;
      return false;
    }
    if (markers.some(isAddPersonMarker) || hasSeparatePlusAndPersonMarkers(markers)) {
      addFriendCount++;
      return false;
    }
    return true;
  });
  return { circles, replayCount, addFriendCount };
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
    context.onLog("View Snaps stopped: the Stories list was not confirmed.");
    return false;
  }
  return true;
}
