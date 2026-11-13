import type { SnapchatContext, UiNode } from "../context";
import type { ScreenPixels } from "../../../androidManager";
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

type AddFriendStoryCards = {
  addFriendCentersX: number[];
  allAreAddFriendCards: boolean;
};

type WhiteGlyph = { x: number; y: number; size: number };

function isSnapchatPurple(red: number, green: number, blue: number): boolean {
  return red >= 105 && blue >= 125 && blue > green * 1.4 && red > green * 1.25;
}

function whiteGlyphComponents(
  screen: ScreenPixels,
  bounds: [number, number, number, number],
): WhiteGlyph[] {
  const left = Math.max(0, bounds[0]);
  const top = Math.max(0, bounds[1]);
  const right = Math.min(screen.width, bounds[2]);
  const bottom = Math.min(screen.height, bounds[3]);
  const width = right - left;
  const height = bottom - top;
  if (width < 12 || height < 8) return [];

  const mask = new Uint8Array(width * height);
  let purplePixels = 0;
  let whitePixels = 0;
  let minPurpleX = width;
  let maxPurpleX = -1;
  let minPurpleY = height;
  let maxPurpleY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = ((top + y) * screen.width + left + x) * screen.channels;
      const red = screen.pixels[offset] ?? 0;
      const green = screen.pixels[offset + 1] ?? red;
      const blue = screen.pixels[offset + 2] ?? red;
      if (isSnapchatPurple(red, green, blue)) {
        purplePixels++;
        minPurpleX = Math.min(minPurpleX, x);
        maxPurpleX = Math.max(maxPurpleX, x);
        minPurpleY = Math.min(minPurpleY, y);
        maxPurpleY = Math.max(maxPurpleY, y);
      }
      if (red >= 218 && green >= 218 && blue >= 218) {
        mask[y * width + x] = 1;
        whitePixels++;
      }
    }
  }

  const area = width * height;
  const purpleWidth = maxPurpleX - minPurpleX + 1;
  const purpleHeight = maxPurpleY - minPurpleY + 1;
  // The add marker is a filled horizontal pill. A purple story ring is thin
  // and circular, so it cannot satisfy the filled-area and wide-pill checks.
  if (
    purplePixels < area * 0.12 ||
    purpleWidth < width * 0.52 ||
    purpleHeight < height * 0.28 ||
    purpleWidth / Math.max(1, purpleHeight) < 1.55 ||
    whitePixels < area * 0.02
  ) return [];

  const visited = new Uint8Array(mask.length);
  const glyphs: WhiteGlyph[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    visited[start] = 1;
    stack.push(start);
    let size = 0;
    let sumX = 0;
    let sumY = 0;
    while (stack.length) {
      const current = stack.pop()!;
      size++;
      const x = current % width;
      const y = Math.floor(current / width);
      sumX += x;
      sumY += y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nextX = x + dx;
          const nextY = y + dy;
          if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
          const next = nextY * width + nextX;
          if (!mask[next] || visited[next]) continue;
          visited[next] = 1;
          stack.push(next);
        }
      }
    }
    if (size >= Math.max(3, area * 0.002)) {
      glyphs.push({ x: sumX / size, y: sumY / size, size });
    }
  }
  return glyphs;
}

function hasAddPersonBadge(screen: ScreenPixels, node: UiNode): boolean {
  const [left, top, right, bottom] = node.bounds;
  const width = right - left;
  const height = bottom - top;
  const glyphs = whiteGlyphComponents(screen, node.bounds)
    .filter(glyph => glyph.y >= height * 0.2 && glyph.y <= height * 0.8);
  // Snapchat's marker contains two separate white glyphs: a plus and a
  // person silhouette, arranged side by side. This avoids treating the common
  // purple ring itself as proof that a friend has no viewable Story.
  return glyphs.some((first, index) => glyphs.slice(index + 1).some(second => {
    const horizontalGap = Math.abs(first.x - second.x);
    const verticalGap = Math.abs(first.y - second.y);
    return horizontalGap >= width * 0.08 &&
      horizontalGap <= width * 0.55 &&
      verticalGap <= height * 0.3;
  }));
}

export function findAddFriendStoryCards(
  nodes: UiNode[],
  screenHeight: number,
  screen: ScreenPixels,
): AddFriendStoryCards {
  const friendsIndex = nodes.findIndex(node =>
    [node.text, node.desc].some(value => /^friends$/i.test(value.trim())),
  );
  const discoverIndex = nodes.findIndex((node, index) =>
    index > friendsIndex && [node.text, node.desc].some(value => /^discover$/i.test(value.trim())),
  );
  if (friendsIndex < 0 || discoverIndex < 0) {
    return { addFriendCentersX: [], allAreAddFriendCards: false };
  }

  const rowTop = nodes[friendsIndex].bounds[3];
  const rowBottom = Math.min(nodes[discoverIndex].bounds[1], screenHeight * 0.9);
  const usernameNodes = nodes.slice(friendsIndex + 1, discoverIndex).filter(node => {
    const username = node.text.trim();
    const [left, top, right, bottom] = node.bounds;
    const width = right - left;
    const height = bottom - top;
    return /View/i.test(node.className) &&
      /^[a-zA-Z0-9._-]{1,30}$/.test(username) &&
      username.toLowerCase() !== "friend_story_circle_thumbnail" &&
      top >= rowTop && bottom <= rowBottom &&
      width >= 55 && width <= screen.width * 0.35 &&
      height >= 20 && height <= screenHeight * 0.06;
  });

  const cardGroups: Array<{ centerX: number; nodes: UiNode[] }> = [];
  for (const node of usernameNodes) {
    const centerX = Math.round((node.bounds[0] + node.bounds[2]) / 2);
    let group = cardGroups.find(candidate => Math.abs(candidate.centerX - centerX) <= 28);
    if (!group) {
      group = { centerX, nodes: [] };
      cardGroups.push(group);
    }
    group.nodes.push(node);
  }

  const addFriendCentersX = cardGroups
    .filter(group => group.nodes.some(node => hasAddPersonBadge(screen, node)))
    .map(group => group.centerX);
  return {
    addFriendCentersX,
    allAreAddFriendCards: cardGroups.length > 0 && addFriendCentersX.length === cardGroups.length,
  };
}

export function findStoryCircles(
  nodes: UiNode[],
  screenHeight: number,
  addFriendCentersX: number[] = [],
): UiNode[] {
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
    node.bounds[3] < screenHeight * 0.9 &&
    !addFriendCentersX.some(x =>
      Math.abs(x - Math.round((node.bounds[0] + node.bounds[2]) / 2)) <= 32,
    ),
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
    context.onLog("View Snaps stopped: the Stories list was not confirmed.");
    return false;
  }
  return true;
}
