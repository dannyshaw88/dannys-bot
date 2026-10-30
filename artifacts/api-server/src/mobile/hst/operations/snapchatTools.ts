import * as android from "../../androidManager";
import { storage } from "../../../storage";
import {
  appendSnapchatReplyHistory,
  getSnapchatReplyHistory,
  hasSentSnapchatBoundlusLink,
} from "../../snapchatReplyHistory";
import { generateSnapchatLunaReply } from "../../snapchatLuna";

type SnapchatTools = {
  shuffleToolOrder: boolean;
  addFriends: { enabled: boolean; min: number; max: number; activatePctMin: number; activatePctMax: number };
  acceptFriends: { enabled: boolean; min: number; max: number; activatePctMin: number; activatePctMax: number };
  replyUnreadChats: { enabled: boolean; min: number; max: number; activatePctMin: number; activatePctMax: number; replyGoal: string };
  viewStories: { enabled: boolean; min: number; max: number; activatePctMin: number; activatePctMax: number; likePercentMin: number; likePercentMax: number; watchSecondsMin: number; watchSecondsMax: number };
  viewSnaps: { enabled: boolean; min: number; max: number; activatePctMin: number; activatePctMax: number; watchSecondsMin: number; watchSecondsMax: number };
};

type DeviceSwipeGesture = {
  x1: number; y1: number; x2: number; y2: number;
  durationMinMs: number; durationMaxMs: number;
  jitterX: number; jitterY: number;
  startJitterMinY?: number; startJitterMaxY?: number;
  pauseMinMs?: number; pauseMaxMs?: number;
  settleMinMs?: number; settleMaxMs?: number;
};

type UiNode = {
  text: string;
  desc: string;
  resourceId: string;
  className: string;
  clickable: boolean;
  selected: boolean;
  bounds: [number, number, number, number];
};

type Context = {
  serial: string;
  slotId?: string;
  tools: SnapchatTools;
  onLog: (message: string) => void;
  isAborted: () => boolean;
  effectiveTypingProfile: (serial: string) => any;
  sleep: (milliseconds: number, timingMode?: "static" | "exact") => Promise<void>;
  swipeGesture?: DeviceSwipeGesture;
};

const shortResourceId = (node: UiNode) => node.resourceId.split("/").pop() ?? node.resourceId;
const decodeXml = (value: string) => value
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&");

function parseNodes(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  const nodeRegex = /<node\b([^>]*)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = nodeRegex.exec(xml)) !== null) {
    const attrs = match[1];
    const get = (key: string) => decodeXml((attrs.match(new RegExp(`${key}="([^"]*)"`)) ?? [])[1] ?? "");
    const boundsMatch = get("bounds").match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
    if (!boundsMatch) continue;
    nodes.push({
      text: get("text"),
      desc: get("content-desc"),
      resourceId: get("resource-id"),
      className: get("class"),
      clickable: get("clickable") === "true",
      selected: get("selected") === "true",
      bounds: boundsMatch.slice(1).map(Number) as [number, number, number, number],
    });
  }
  return nodes;
}

const nodeLabel = (node: UiNode) => `${node.text} ${node.desc}`.trim();
const center = (node: UiNode) => ({
  x: Math.round((node.bounds[0] + node.bounds[2]) / 2),
  y: Math.round((node.bounds[1] + node.bounds[3]) / 2),
});
const BANNER_RECHECK_MS = 120;

async function dump(serial: string): Promise<{ xml: string; nodes: UiNode[] }> {
  const xml = await android.dumpUi(serial).catch(() => "");
  return { xml, nodes: parseNodes(xml) };
}

async function tapNode(context: Context, node: UiNode, reason: string, settleMs = 700) {
  if (context.isAborted()) return false;
  const { x, y } = center(node);
  await android.tap(context.serial, x, y, "bot", `Snapchat: ${reason}`, "automation");
  await context.sleep(settleMs);
  return !context.isAborted();
}

function exactClickable(nodes: UiNode[], labels: string[]): UiNode | undefined {
  const wanted = new Set(labels.map(value => value.toLowerCase()));
  return nodes.find(node =>
    node.clickable &&
    [node.text, node.desc].some(value => wanted.has(value.trim().toLowerCase())),
  );
}

function findUnreadTab(nodes: UiNode[], screenHeight: number): UiNode | undefined {
  return nodes.find(node => {
    if (node.bounds[1] > screenHeight * 0.4) return false;
    const labelMatches = [node.text, node.desc].some(value =>
      /^unread(?:\s+messages?)?(?:\s*\(\d+\))?$/i.test(value.trim()),
    );
    const resourceMatches = /(?:^|[_-])unread(?:[_-].*)?(?:tab|filter)|(?:tab|filter).*unread/i
      .test(node.resourceId);
    return labelMatches || (node.clickable && resourceMatches);
  });
}

function isAddFriendsPage(xml: string): boolean {
  return /add_friends_root/i.test(xml) &&
    /add_friends_title/i.test(xml) &&
    /find friends/i.test(xml);
}

function findOccludingBanner(nodes: UiNode[], target: UiNode, screenWidth: number, screenHeight: number) {
  const point = center(target);
  const targetArea = (target.bounds[2] - target.bounds[0]) * (target.bounds[3] - target.bounds[1]);
  const screenArea = screenWidth * screenHeight;
  return nodes.find(node => {
    if (node === target || !node.clickable) return false;
    const [left, top, right, bottom] = node.bounds;
    const area = (right - left) * (bottom - top);
    const coversTapPoint = point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
    // The normal clickable wrapper around Add Friends is only slightly larger
    // than the icon. A banner-sized hitbox is substantially larger and can
    // intercept the same coordinate.
    return coversTapPoint &&
      area > targetArea * 2.5 &&
      area < screenArea * 0.5;
  });
}

async function tapExact(context: Context, labels: string[], reason: string): Promise<boolean> {
  const { nodes } = await dump(context.serial);
  const node = exactClickable(nodes, labels);
  return node ? tapNode(context, node, reason) : false;
}

async function waitForUnreadTab(context: Context): Promise<Awaited<ReturnType<typeof dump>> | null> {
  const { h: screenHeight } = await android.getScreenSizeAsync(context.serial);
  const startedAt = Date.now();
  let waitLogged = false;
  while (!context.isAborted()) {
    const state = await dump(context.serial);
    const unreadTab = findUnreadTab(state.nodes, screenHeight);
    if (unreadTab) {
      context.onLog("Reply to Unread Chats: Unread tab appeared; tapping it now.");
      if (!await tapNode(context, unreadTab, "open the Unread chat filter")) return null;
      return await dump(context.serial);
    }
    const remainingMs = 30_000 - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      context.onLog("Reply to Unread Chats stopped: Unread tab did not appear within 30 seconds.");
      return null;
    }
    if (!waitLogged) {
      context.onLog("Reply to Unread Chats: waiting up to 30 seconds for Unread; checking every 5 seconds.");
      waitLogged = true;
    }
    await context.sleep(Math.min(5_000, remainingMs), "exact");
  }
  return null;
}

async function openAddFriends(context: Context): Promise<boolean> {
  const { w: screenWidth, h: screenHeight } = await android.getScreenSizeAsync(context.serial);
  let cameraWaitLogged = false;
  let iconWaitLogged = false;
  let bannerWaitLogged = false;
  let pageWaitLogged = false;
  while (!context.isAborted()) {
    const state = await dump(context.serial);
    if (isAddFriendsPage(state.xml)) return true;

    // Other tools can leave Snapchat on a different tab (or a transient
    // loading surface). Return to Camera before retrying the person-plus
    // control; never turn a temporary navigation miss into a skipped tool.
    if (!/camera_page/i.test(state.xml)) {
      const cameraTab = state.nodes.find(node =>
        node.clickable && shortResourceId(node) === "ngs_camera_icon_container",
      );
      if (cameraTab) {
        cameraWaitLogged = false;
        if (!await tapNode(context, cameraTab, "return to Camera before retrying Add Friends")) return false;
      } else if (!cameraWaitLogged) {
        context.onLog("Add Friends: waiting for Snapchat's Camera tab to become available; will retry.");
        cameraWaitLogged = true;
      }
      await context.sleep(BANNER_RECHECK_MS, "exact");
      continue;
    }
    cameraWaitLogged = false;

    const addFriendsIcon = state.nodes.find(node =>
      shortResourceId(node) === "neon_add_friend_button_container",
    );
    if (!addFriendsIcon) {
      if (!iconWaitLogged) {
        context.onLog("Add Friends: waiting for the top-right person-plus icon; will retry.");
        iconWaitLogged = true;
      }
      await context.sleep(BANNER_RECHECK_MS, "exact");
      continue;
    }
    iconWaitLogged = false;
    const occludingBanner = findOccludingBanner(state.nodes, addFriendsIcon, screenWidth, screenHeight);
    if (occludingBanner) {
      if (!bannerWaitLogged) {
        context.onLog("Add Friends: person-plus is covered; checking again until the tap is clear.");
        bannerWaitLogged = true;
      }
      await context.sleep(BANNER_RECHECK_MS, "exact");
      continue;
    }
    bannerWaitLogged = false;
    pageWaitLogged = false;
    if (!await tapNode(context, addFriendsIcon, "open Add Friends from the top-right person-plus icon")) return false;
    const afterTap = await dump(context.serial);
    if (isAddFriendsPage(afterTap.xml)) return true;
    if (!pageWaitLogged) {
      context.onLog("Add Friends: the page did not open yet; checking the live screen and retrying.");
      pageWaitLogged = true;
    }
    await context.sleep(BANNER_RECHECK_MS, "exact");
  }
  return false;
}

function randomCount(min: number, max: number): number {
  const low = Math.max(0, Math.min(10, Math.min(min, max)));
  const high = Math.max(low, Math.min(10, Math.max(min, max)));
  return low + Math.floor(Math.random() * (high - low + 1));
}

function randomSeconds(min: number, max: number): number {
  const low = Math.max(1, Math.min(60, Math.min(min, max)));
  const high = Math.max(low, Math.min(60, Math.max(min, max)));
  return low + Math.floor(Math.random() * (high - low + 1));
}

function randomPercent(min: number, max: number): number {
  const low = Math.max(0, Math.min(100, Math.min(min, max)));
  const high = Math.max(low, Math.min(100, Math.max(min, max)));
  return low + Math.floor(Math.random() * (high - low + 1));
}

function isSpotlightSurface(xml: string, nodes: UiNode[]): boolean {
  return /spotlight_container/i.test(xml) &&
    nodes.some(node => node.text.trim().toLowerCase() === "spotlight" && node.bounds[1] < 400);
}

async function openSpotlight(context: Context): Promise<boolean> {
  const { nodes } = await dump(context.serial);
  const button = nodes.find(node =>
    node.clickable && node.resourceId.split("/").pop() === "ngs_spotlight_icon_container",
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

function isStoriesListSurface(nodes: UiNode[]): boolean {
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

function isSnapMediaViewer(xml: string, nodes: UiNode[]): boolean {
  return /opera_viewer/i.test(xml) &&
    nodes.some(node => shortResourceId(node) === "chrome_title") &&
    nodes.some(node =>
      shortResourceId(node) === "base_image_layer_container" ||
      /base_.*video.*layer|video.*viewer/i.test(shortResourceId(node)) ||
      /(?:SurfaceView|TextureView|VideoView)$/i.test(node.className),
    );
}

async function openStories(context: Context): Promise<boolean> {
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

function findStoryCircles(nodes: UiNode[], screenHeight: number): UiNode[] {
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

async function swipeByDeviceGesture(context: Context): Promise<boolean> {
  const gesture = context.swipeGesture;
  if (!gesture) {
    context.onLog("View Snaps stopped: configure a swipe gesture in My Device before scrolling Spotlight.");
    return false;
  }
  const points = [gesture.x1, gesture.y1, gesture.x2, gesture.y2];
  if (points.some(value => !Number.isFinite(value) || value <= 0) ||
      (gesture.x1 === gesture.x2 && gesture.y1 === gesture.y2) ||
      !Number.isFinite(gesture.durationMinMs) || !Number.isFinite(gesture.durationMaxMs)) {
    context.onLog("View Snaps stopped: the saved My Device swipe gesture is incomplete or invalid.");
    return false;
  }
  const durationMin = Math.max(1, Math.min(gesture.durationMinMs, gesture.durationMaxMs));
  const durationMax = Math.max(durationMin, Math.max(gesture.durationMinMs, gesture.durationMaxMs));
  const duration = Math.round(durationMin + Math.random() * (durationMax - durationMin));
  const jitter = (first: number, second: number) => {
    const low = Math.min(first, second);
    const high = Math.max(first, second);
    return Math.round(low + Math.random() * (high - low));
  };
  const jitterX = Number.isFinite(gesture.jitterX) ? Math.abs(gesture.jitterX) : 0;
  const jitterY = Number.isFinite(gesture.jitterY) ? Math.abs(gesture.jitterY) : 0;
  const startJitterMinY = Number.isFinite(gesture.startJitterMinY) ? gesture.startJitterMinY! : 0;
  const startJitterMaxY = Number.isFinite(gesture.startJitterMaxY) ? gesture.startJitterMaxY! : startJitterMinY;
  const dx = jitter(-jitterX, jitterX);
  const dy1 = jitter(startJitterMinY, startJitterMaxY);
  const dy2 = jitter(-jitterY, jitterY);
  const pauseMin = Number.isFinite(gesture.pauseMinMs) ? Math.max(0, gesture.pauseMinMs!) : 0;
  const pauseMax = Number.isFinite(gesture.pauseMaxMs) ? Math.max(pauseMin, gesture.pauseMaxMs!) : pauseMin;
  const settleMin = Number.isFinite(gesture.settleMinMs) ? Math.max(0, gesture.settleMinMs!) : 0;
  const settleMax = Number.isFinite(gesture.settleMaxMs) ? Math.max(settleMin, gesture.settleMaxMs!) : settleMin;
  if (pauseMax > 0) await context.sleep(jitter(pauseMin, pauseMax));
  await android.swipe(
    context.serial,
    gesture.x1 + dx,
    gesture.y1 + dy1,
    gesture.x2 + dx,
    gesture.y2 + dy1 + dy2,
    duration,
    false,
  );
  if (settleMax > 0) await context.sleep(jitter(settleMin, settleMax));
  return !context.isAborted();
}

function visibleConversation(nodes: UiNode[], composerTop: number): string[] {
  const excluded = /^(send|chat|call|video|audio|camera|back|more|typing|delivered|opened|seen|unread|new snap|today|yesterday|message)$/i;
  const seen = new Set<string>();
  return nodes
    .filter(node => node.bounds[1] >= 220 && node.bounds[1] < composerTop && !/edittext/i.test(node.className))
    .sort((a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0])
    .map(node => {
      const text = node.text.trim();
      const description = node.desc.trim();
      if (text && description && description.toLowerCase() !== text.toLowerCase() &&
          /\b(sent|received|from|you|message|snap)\b/i.test(description)) {
        return `${description}: ${text}`;
      }
      return text || description;
    })
    .filter(text => {
      const key = text.toLowerCase().replace(/\s+/g, " ");
      if (!key || excluded.test(text) || key.length > 700 || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(-25);
}

const normalizedText = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();

async function readVerifiedSnapchatUsername(context: Context, displayName: string): Promise<string | null> {
  const thread = await dump(context.serial);
  const nameNode = thread.nodes.find(node =>
    node.clickable &&
    node.bounds[1] < 400 &&
    node.bounds[0] > 140 &&
    normalizedText(node.text) === normalizedText(displayName),
  );
  if (!nameNode || !await tapNode(context, nameNode, `open ${displayName}'s name to verify username`)) return null;

  const profile = await dump(context.serial);
  const profileName = profile.nodes.find(node => shortResourceId(node) === "profile_identity_section_display_name");
  const usernameNode = profile.nodes.find(node => shortResourceId(node) === "profile_identity_section_username");
  const profileOpen = profile.nodes.some(node => shortResourceId(node) === "unified_profile_3d_bitmoji");
  const verifiedUsername = usernameNode?.text.trim().replace(/^@/, "");
  if (!profileOpen || !profileName || normalizedText(profileName.text) !== normalizedText(displayName) ||
      !verifiedUsername || !/^[a-z0-9._]{2,40}$/i.test(verifiedUsername)) {
    context.onLog(`Reply to Unread Chats stopped: Snapchat profile identity could not be verified for ${displayName}.`);
    return null;
  }

  const dismiss = profile.nodes.find(node => shortResourceId(node) === "unified_profile_dismiss_button");
  if (!dismiss || !await tapNode(context, dismiss, "return from the verified contact profile")) return null;
  const returned = await dump(context.serial);
  const returnedToThread = returned.nodes.some(node =>
    node.bounds[1] < 400 && normalizedText(node.text) === normalizedText(displayName),
  );
  if (!returnedToThread) {
    context.onLog("Reply to Unread Chats stopped: the verified contact conversation did not reopen after profile lookup.");
    return null;
  }
  return verifiedUsername.toLowerCase();
}

async function exitSnapchatConversation(context: Context): Promise<boolean> {
  let state = await dump(context.serial);
  if (state.nodes.some(node => shortResourceId(node) === "unified_profile_3d_bitmoji")) {
    const dismiss = state.nodes.find(node => shortResourceId(node) === "unified_profile_dismiss_button");
    if (!dismiss || !await tapNode(context, dismiss, "leave the contact profile")) return false;
    state = await dump(context.serial);
  }
  const chevron = state.nodes
    .filter(node => node.bounds[0] <= 20 && node.bounds[2] <= 145 && node.bounds[1] >= 100 && node.bounds[1] <= 260)
    .sort((a, b) => (a.bounds[2] - a.bounds[0]) - (b.bounds[2] - b.bounds[0]))[0];
  if (!chevron || !await tapNode(context, chevron, "exit the conversation with its top-left chevron")) return false;
  const after = await dump(context.serial);
  return Boolean(exactClickable(after.nodes, ["Chat"])) &&
    !after.nodes.some(node => /edittext/i.test(node.className) && /chat_input_text_field/i.test(node.resourceId));
}

async function recoverFromUnreadSnapViewer(
  context: Context,
  displayName: string,
  identity: string,
  opened: Awaited<ReturnType<typeof dump>>,
): Promise<{ detected: boolean; list?: Awaited<ReturnType<typeof dump>> }> {
  if (!isSnapMediaViewer(opened.xml, opened.nodes)) return { detected: false };

  context.onLog(`Reply to Unread Chats: ${displayName}'s unread item opened a photo/video Snap; swiping down to close it.`);
  const { w, h } = await android.getScreenSizeAsync(context.serial);
  let state = opened;
  for (let attempt = 0; attempt < 2 && isSnapMediaViewer(state.xml, state.nodes); attempt++) {
    if (context.isAborted()) return { detected: true };
    await android.swipe(
      context.serial,
      Math.round(w * 0.5),
      Math.round(h * 0.35),
      Math.round(w * 0.5),
      Math.round(h * 0.85),
      300,
      false,
    );
    await context.sleep(500, "exact");
    state = await dump(context.serial);
    if (isSnapMediaViewer(state.xml, state.nodes) && attempt === 0) {
      context.onLog("Reply to Unread Chats: Snap viewer is still open; retrying the downward dismiss swipe.");
    }
  }
  if (isSnapMediaViewer(state.xml, state.nodes)) {
    context.onLog("Reply to Unread Chats stopped: Snapchat's photo/video viewer did not close after two downward swipes.");
    return { detected: true };
  }

  const returnedToConversation =
    state.nodes.some(node => node.bounds[1] < 400 && normalizedText(node.text) === identity) &&
    /\b(chat|message)\b/i.test(state.xml);
  if (returnedToConversation) {
    if (!await exitSnapchatConversation(context).catch(() => false)) {
      context.onLog(`Reply to Unread Chats stopped: could not exit ${displayName}'s conversation after closing the Snap.`);
      return { detected: true };
    }
    state = await dump(context.serial);
  }

  const returnedToChatList =
    Boolean(exactClickable(state.nodes, ["Chat"])) &&
    !state.nodes.some(node => /edittext/i.test(node.className) && /chat_input_text_field/i.test(node.resourceId));
  if (!returnedToChatList) {
    context.onLog("Reply to Unread Chats stopped: the Snap closed, but Snapchat's chat list was not confirmed.");
    return { detected: true };
  }
  context.onLog(`Reply to Unread Chats: closed the received Snap, exited the conversation, and will continue on the Unread list.`);
  return { detected: true, list: await dump(context.serial) };
}

function hasNotAddedFriendNotice(state: Awaited<ReturnType<typeof dump>>): boolean {
  const visibleText = state.nodes
    .map(node => `${node.text} ${node.desc}`)
    .join(" ")
    .replace(/\s+/g, " ");
  return /\bhas not added you as a friend\b/i.test(visibleText);
}

async function handleNotAddedFriendNotice(
  context: Context,
  displayName: string,
  state: Awaited<ReturnType<typeof dump>>,
): Promise<"not-present" | "exited" | "exit-failed"> {
  if (!hasNotAddedFriendNotice(state)) return "not-present";
  context.onLog(`Reply to Unread Chats: Snapchat says ${displayName} has not added this account; skipping the reply and exiting with the top-left chevron.`);
  const exited = await exitSnapchatConversation(context).catch(() => false);
  if (!exited) {
    context.onLog(`Reply to Unread Chats stopped: could not exit ${displayName}'s conversation after Snapchat showed the friend notice.`);
    return "exit-failed";
  }
  return "exited";
}

function unreadChatRows(nodes: UiNode[]) {
  return nodes.flatMap(marker => {
    if (!/ff_item/i.test(shortResourceId(marker)) ||
        !/\bnew\s+(chats?|snaps?|messages?)\b/i.test(marker.desc)) return [];
    const rowHeight = marker.bounds[3] - marker.bounds[1];
    const names = nodes.filter(node =>
      node.text.trim() &&
      node.bounds[1] >= marker.bounds[1] &&
      node.bounds[3] <= marker.bounds[3] &&
      node.bounds[1] < marker.bounds[1] + rowHeight * 0.48 &&
      !/^(unread|received|sent|opened|new|camera|chat)$/i.test(node.text.trim()),
    ).sort((a, b) => a.bounds[1] - b.bounds[1]);
    const displayName = names[0]?.text.trim();
    return displayName ? [{ marker, displayName }] : [];
  });
}

async function generateContextualReply(
  goal: string,
  peer: string,
  transcript: string[],
  history: ReturnType<typeof getSnapchatReplyHistory>,
): Promise<string> {
  const settings = await storage.getGlobalSettings();
  const apiKey = String((settings as any).openaiApiKey ?? "").trim() || (process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("Add an OpenAI API key in Settings → Security.");
  return generateSnapchatLunaReply(apiKey, goal, peer, transcript, history);
}

async function runAddFriends(context: Context) {
  const requested = randomCount(context.tools.addFriends.min, context.tools.addFriends.max);
  if (!context.tools.addFriends.enabled || requested === 0) return;
  if (!await openAddFriends(context)) return;
  const { w: screenWidth, h: screenHeight } = await android.getScreenSizeAsync(context.serial);
  let added = 0;
  let blockedFriend = "";
  while (added < requested && !context.isAborted()) {
    const { xml, nodes } = await dump(context.serial);
    if (!isAddFriendsPage(xml)) {
      context.onLog("Add Friends stopped: the verified Add Friends page is no longer open.");
      break;
    }
    const findFriendsStart = nodes.findIndex(node =>
      shortResourceId(node) === "section-title" &&
      [node.text, node.desc].some(value => /^find friends$/i.test(value.trim())),
    );
    if (findFriendsStart < 0) {
      context.onLog("Add Friends stopped: the Find Friends section title was not found.");
      break;
    }
    const findFriendsTitle = nodes[findFriendsStart];
    const acceptFriendsStart = nodes.findIndex((node, index) =>
      index > findFriendsStart &&
      shortResourceId(node) === "section-title" &&
      [node.text, node.desc].some(value => /^accept friends$/i.test(value.trim())),
    );
    const sectionEnd = acceptFriendsStart < 0 ? nodes.length : acceptFriendsStart;
    const addButtons = nodes.slice(findFriendsStart + 1, sectionEnd).filter(node =>
      shortResourceId(node) === "scu_search_action_button" &&
      [node.text, node.desc].some(value => /^add$/i.test(value.trim())) &&
      node.bounds[2] > node.bounds[0] && node.bounds[3] > node.bounds[1] &&
      node.bounds[1] >= findFriendsTitle.bounds[3] &&
      node.bounds[3] < screenHeight * 0.95,
    );
    const candidate = addButtons[0];
    if (!candidate) {
      context.onLog("Add Friends stopped: no Add button was found under Find Friends.");
      break;
    }
    const candidateY = center(candidate).y;
    const row = nodes.find(node =>
      shortResourceId(node) === "scu_search_friend_cell" &&
      candidateY >= node.bounds[1] && candidateY <= node.bounds[3],
    );
    const username = row && nodes.find(node =>
      shortResourceId(node) === "result-title" &&
      node.bounds[1] >= row.bounds[1] && node.bounds[3] <= row.bounds[3],
    );
    const friendName = username ? nodeLabel(username) : "";
    if (!friendName) {
      context.onLog("Add Friends stopped: the selected Add button could not be matched to a visible friend row.");
      break;
    }
    if (findOccludingBanner(nodes, candidate, screenWidth, screenHeight)) {
      if (blockedFriend !== friendName) {
        blockedFriend = friendName;
        context.onLog(`Add Friends: waiting for the banner to clear Add for ${friendName}.`);
      }
      await context.sleep(BANNER_RECHECK_MS, "exact");
      continue;
    }
    blockedFriend = "";
    if (!await tapNode(context, candidate, `tap Add for ${friendName} under Find Friends`)) break;
    const confirmation = await dump(context.serial);
    if (!isAddFriendsPage(confirmation.xml)) {
      context.onLog("Add Friends stopped: the Add Friends page changed before the request could be confirmed.");
      break;
    }
    const sameRowStillAdd = confirmation.nodes.some(node => {
      if (shortResourceId(node) !== "scu_search_action_button" ||
          ![node.text, node.desc].some(value => /^add$/i.test(value.trim()))) return false;
      const y = center(node).y;
      const matchingRow = confirmation.nodes.find(candidateRow =>
        shortResourceId(candidateRow) === "scu_search_friend_cell" &&
        y >= candidateRow.bounds[1] && y <= candidateRow.bounds[3],
      );
      if (!matchingRow) return false;
      const matchingName = confirmation.nodes.find(candidateName =>
        shortResourceId(candidateName) === "result-title" &&
        candidateName.bounds[1] >= matchingRow.bounds[1] &&
        candidateName.bounds[3] <= matchingRow.bounds[3],
      );
      return Boolean(matchingName && nodeLabel(matchingName) === friendName);
    });
    if (sameRowStillAdd) {
      context.onLog(`Add Friends stopped: Snapchat still shows Add for ${friendName}; the request was not confirmed.`);
      break;
    }
    added++;
  }
  context.onLog(`Add Friends: confirmed ${added}/${requested} friend request(s) from the Find Friends section.`);
}

async function runAcceptFriends(context: Context) {
  const requested = randomCount(context.tools.acceptFriends.min, context.tools.acceptFriends.max);
  if (!context.tools.acceptFriends.enabled || requested === 0) return;
  if (!await openAddFriends(context)) return;
  const { w: screenWidth, h: screenHeight } = await android.getScreenSizeAsync(context.serial);
  let blockedAcceptance = "";
  let viewMoreBannerWaitLogged = false;

  const getAddedMeSection = (nodes: UiNode[]) => {
    const start = nodes.findIndex(node =>
      shortResourceId(node) === "section-title" &&
      [node.text, node.desc].some(value => /^added me$/i.test(value.trim())),
    );
    if (start < 0) return null;
    const nextSection = nodes.findIndex((node, index) =>
      index > start &&
      shortResourceId(node) === "section-title" &&
      [node.text, node.desc].some(value => /^find friends$/i.test(value.trim())),
    );
    return { start, end: nextSection < 0 ? nodes.length : nextSection };
  };
  const getAcceptRows = (nodes: UiNode[], section: { start: number; end: number }, screenHeight: number) => {
    const sectionNodes = nodes.slice(section.start + 1, section.end);
    return sectionNodes
      .filter(node =>
        shortResourceId(node) === "scu_search_action_button" &&
        [node.text, node.desc].some(value => /^accept$/i.test(value.trim())) &&
        node.bounds[3] < screenHeight * 0.95,
      )
      .flatMap(button => {
        const y = center(button).y;
        const row = sectionNodes.find(node =>
          shortResourceId(node) === "scu_search_friend_cell" &&
          y >= node.bounds[1] && y <= node.bounds[3],
        );
        const name = row && sectionNodes.find(node =>
          shortResourceId(node) === "result-title" &&
          node.bounds[1] >= row.bounds[1] && node.bounds[3] <= row.bounds[3],
        );
        return row && name ? [{ button, name: nodeLabel(name) }] : [];
      });
  };

  let state = await dump(context.serial);
  if (!isAddFriendsPage(state.xml)) {
    context.onLog("Accept Friends stopped: the live Add Friends screen was not confirmed.");
    return;
  }

  // Expand each optional Added Me batch while the View More control remains.
  // The exact resource ID plus its changing label prevents tapping View Less.
  for (let expansion = 0; expansion < 10 && !context.isAborted(); expansion++) {
    const section = getAddedMeSection(state.nodes);
    if (!section) {
      context.onLog("Accept Friends stopped: the Added Me section was not found.");
      return;
    }
    const moreButton = state.nodes.slice(section.start + 1, section.end).find(node =>
      shortResourceId(node) === "add_friends_view_more_cell" &&
      [node.text, node.desc].some(value => /^view\s+\d+\s+more$/i.test(value.trim())),
    );
    if (!moreButton) break;
    const beforeLabel = nodeLabel(moreButton);
    const beforeCount = getAcceptRows(state.nodes, section, screenHeight).length;
    if (findOccludingBanner(state.nodes, moreButton, screenWidth, screenHeight)) {
      if (!viewMoreBannerWaitLogged) {
        context.onLog("Accept Friends: waiting for the banner to clear View More.");
        viewMoreBannerWaitLogged = true;
      }
      await context.sleep(BANNER_RECHECK_MS, "exact");
      state = await dump(context.serial);
      expansion--;
      continue;
    }
    viewMoreBannerWaitLogged = false;
    if (!await tapNode(context, moreButton, `expand Added Me (${beforeLabel})`)) return;
    const expanded = await dump(context.serial);
    if (!isAddFriendsPage(expanded.xml)) {
      context.onLog("Accept Friends stopped: Snapchat left the Add Friends screen while expanding requests.");
      return;
    }
    const expandedSection = getAddedMeSection(expanded.nodes);
    if (!expandedSection) {
      context.onLog("Accept Friends stopped: Added Me disappeared after tapping View More.");
      return;
    }
    const expandedMore = expanded.nodes.slice(expandedSection.start + 1, expandedSection.end).find(node =>
      shortResourceId(node) === "add_friends_view_more_cell" &&
      [node.text, node.desc].some(value => /^view\s+\d+\s+more$/i.test(value.trim())),
    );
    const afterCount = getAcceptRows(expanded.nodes, expandedSection, screenHeight).length;
    const afterLabel = expandedMore ? nodeLabel(expandedMore) : "";
    if (afterCount <= beforeCount && afterLabel === beforeLabel) {
      context.onLog("Accept Friends stopped: View More did not reveal additional request rows.");
      return;
    }
    state = expanded;
  }

  let accepted = 0;
  let pendingAcceptance: string | null = null;
  while (accepted < requested && !context.isAborted()) {
    if (pendingAcceptance) {
      const seconds = randomSeconds(1, 3);
      context.onLog(`Accept Friends: waiting ${seconds}s between accepts.`);
      await context.sleep(seconds * 1000);
      if (context.isAborted()) break;
      state = await dump(context.serial);
      if (!isAddFriendsPage(state.xml)) {
        context.onLog("Accept Friends stopped: Snapchat left the verified Add Friends screen.");
        break;
      }
      const pendingSection = getAddedMeSection(state.nodes);
      if (!pendingSection) {
        context.onLog("Accept Friends stopped: Added Me could not be confirmed after tapping Accept.");
        break;
      }
      const pendingStillVisible = getAcceptRows(
        state.nodes,
        pendingSection,
        screenHeight,
      ).some(row => row.name === pendingAcceptance);
      if (pendingStillVisible) {
        context.onLog(`Accept Friends stopped: Snapchat still shows Accept for ${pendingAcceptance}.`);
        break;
      }
      accepted++;
      pendingAcceptance = null;
      if (accepted >= requested) break;
    }
    state = await dump(context.serial);
    if (!isAddFriendsPage(state.xml)) {
      context.onLog("Accept Friends stopped: Snapchat left the verified Add Friends screen.");
      break;
    }
    const section = getAddedMeSection(state.nodes);
    if (!section) {
      context.onLog("Accept Friends stopped: the Added Me section is no longer visible.");
      break;
    }
    const candidate = getAcceptRows(state.nodes, section, screenHeight)[0];
    if (!candidate) {
      context.onLog("Accept Friends stopped: no labeled Accept badge was found under Added Me.");
      break;
    }
    if (findOccludingBanner(state.nodes, candidate.button, screenWidth, screenHeight)) {
      if (blockedAcceptance !== candidate.name) {
        blockedAcceptance = candidate.name;
        context.onLog(`Accept Friends: waiting for the banner to clear Accept for ${candidate.name}.`);
      }
      await context.sleep(BANNER_RECHECK_MS, "exact");
      continue;
    }
    blockedAcceptance = "";
    if (!await tapNode(context, candidate.button, `accept ${candidate.name} under Added Me`, 250)) break;
    pendingAcceptance = candidate.name;
  }
  context.onLog(`Accept Friends: accepted ${accepted}/${requested} visible incoming requests.`);
}

async function collapseAddFriendsBeforeNextTool(context: Context): Promise<boolean> {
  const { w: screenWidth, h: screenHeight } = await android.getScreenSizeAsync(context.serial);
  let chevronWaitLogged = false;
  let missingChevronLogged = false;
  let cameraWaitLogged = false;
  while (!context.isAborted()) {
    const current = await dump(context.serial);
    if (/camera_page/i.test(current.xml) && !/add_friends_root/i.test(current.xml)) return true;

    if (/add_friends_root/i.test(current.xml)) {
      cameraWaitLogged = false;
      const dismiss = current.nodes.find(node => shortResourceId(node) === "add_friends_dismiss");
      if (dismiss) {
        missingChevronLogged = false;
        const occludingBanner = findOccludingBanner(current.nodes, dismiss, screenWidth, screenHeight);
        if (occludingBanner) {
          if (!chevronWaitLogged) {
            context.onLog("Snapchat: collapse chevron is covered; checking again until the tap is clear.");
            chevronWaitLogged = true;
          }
          await context.sleep(BANNER_RECHECK_MS, "exact");
          continue;
        }
        chevronWaitLogged = false;
        if (!await tapNode(context, dismiss, "collapse the Add Friends list before the next tool")) return false;
        const after = await dump(context.serial);
        if (/camera_page/i.test(after.xml) && !/add_friends_root/i.test(after.xml)) {
          context.onLog("Snapchat: Add Friends panel collapsed with the down-chevron.");
          return true;
        }
      } else if (!missingChevronLogged) {
        context.onLog("Snapchat: waiting for the Add Friends collapse chevron; will retry.");
        missingChevronLogged = true;
      }
    } else {
      missingChevronLogged = false;
      const cameraTab = current.nodes.find(node =>
        node.clickable && shortResourceId(node) === "ngs_camera_icon_container",
      );
      if (cameraTab) {
        cameraWaitLogged = false;
        if (!await tapNode(context, cameraTab, "return to Camera before continuing")) return false;
      } else if (!cameraWaitLogged) {
        context.onLog("Snapchat: waiting for Camera or the Add Friends list; will retry.");
        cameraWaitLogged = true;
      }
    }
    await context.sleep(BANNER_RECHECK_MS, "exact");
  }
  return false;
}

async function runReplyUnreadChats(context: Context) {
  const { enabled, replyGoal } = context.tools.replyUnreadChats;
  const requested = randomCount(context.tools.replyUnreadChats.min, context.tools.replyUnreadChats.max);
  if (!enabled || requested === 0) return;
  if (!context.slotId) {
    context.onLog("Reply to Unread Chats stopped: this Snapchat slot has no stable saved ID for private history.");
    return;
  }
  if (!replyGoal.trim()) {
    context.onLog("Reply to Unread Chats skipped: add a conversation goal in Snapchat Step 2 first.");
    return;
  }
  if (!await tapExact(context, ["Chat"], "open the chat list")) {
    context.onLog("Reply to Unread Chats skipped: Chat tab was not found.");
    return;
  }
  let list = await waitForUnreadTab(context);
  if (!list) return;
  if (!exactClickable(list.nodes, ["Chat"]) ||
      list.nodes.some(node => /edittext/i.test(node.className) && /chat_input_text_field/i.test(node.resourceId))) {
    context.onLog("Reply to Unread Chats stopped: the Unread chat list was not confirmed after tapping its tab.");
    return;
  }

  let replied = 0;
  const visited = new Set<string>();
  while (replied < requested && !context.isAborted()) {
    const rows = unreadChatRows(list.nodes);
    const row = rows.find(item => !visited.has(normalizedText(item.displayName)));
    if (!row) {
      context.onLog("Reply to Unread Chats: no clearly marked unread chat row remains.");
      break;
    }
    const identity = normalizedText(row.displayName);
    if (visited.has(identity)) break;
    visited.add(identity);
    if (!await tapNode(context, row.marker, `open unread chat for ${row.displayName}`)) break;
    const openedThread = await dump(context.serial);
    const snapRecovery = await recoverFromUnreadSnapViewer(
      context,
      row.displayName,
      identity,
      openedThread,
    );
    if (snapRecovery.detected) {
      if (!snapRecovery.list) break;
      list = snapRecovery.list;
      continue;
    }
    const headerConfirmsPeer = openedThread.nodes.some(node =>
      node.bounds[1] < 400 &&
      !/edittext/i.test(node.className) &&
      normalizedText(node.text) === identity,
    );
    if (!headerConfirmsPeer || !/\b(chat|message)\b/i.test(openedThread.xml)) {
      context.onLog("Reply to Unread Chats stopped: the opened conversation did not confirm the selected contact.");
      await exitSnapchatConversation(context).catch(() => false);
      break;
    }
    const openedNotice = await handleNotAddedFriendNotice(context, row.displayName, openedThread);
    if (openedNotice === "exited") {
      list = await dump(context.serial);
      continue;
    }
    if (openedNotice === "exit-failed") break;
    const username = await readVerifiedSnapchatUsername(context, row.displayName);
    if (!username) {
      await exitSnapchatConversation(context).catch(() => false);
      break;
    }
    if (hasSentSnapchatBoundlusLink(context.slotId, username)) {
      context.onLog(`Reply to Unread Chats skipped for @${username}: the Boundlus link was already sent for this Snapchat slot.`);
      await exitSnapchatConversation(context).catch(() => false);
      list = await dump(context.serial);
      continue;
    }
    const thread = await dump(context.serial);
    const threadNotice = await handleNotAddedFriendNotice(context, row.displayName, thread);
    if (threadNotice === "exited") {
      list = await dump(context.serial);
      continue;
    }
    if (threadNotice === "exit-failed") break;
    const composer = thread.nodes.find(node =>
      /edittext/i.test(node.className) && /chat_input_text_field/i.test(node.resourceId),
    );
    const threadConfirmsPeer = thread.nodes.some(node =>
      node.bounds[1] < 400 && normalizedText(node.text) === identity,
    );
    if (!threadConfirmsPeer || !composer || !/\b(chat|message)\b/i.test(thread.xml)) {
      context.onLog("Reply to Unread Chats stopped: the verified contact conversation or chat composer was not confirmed.");
      await exitSnapchatConversation(context).catch(() => false);
      break;
    }
    const transcript = visibleConversation(thread.nodes, composer.bounds[1]);
    if (transcript.length === 0) {
      context.onLog("Reply to Unread Chats skipped: no readable conversation context was found.");
      await exitSnapchatConversation(context).catch(() => false);
      break;
    }
    let reply: string;
    try {
      const history = getSnapchatReplyHistory(context.slotId, username);
      reply = await generateContextualReply(replyGoal, username, transcript, history);
    } catch (error) {
      context.onLog(`Reply to Unread Chats skipped: ${error instanceof Error ? error.message : "GPT-6 Luna could not draft a reply."}`);
      await exitSnapchatConversation(context).catch(() => false);
      break;
    }
    if (!reply) {
      context.onLog(`Reply to Unread Chats: GPT-6 Luna deferred the reply for ${username}.`);
      await exitSnapchatConversation(context).catch(() => false);
      break;
    }
    context.onLog(`GPT-6 Luna drafted a reply (${reply.length} characters); it has not been sent yet.`);
    const verifiedThread = await dump(context.serial);
    const lateNotice = await handleNotAddedFriendNotice(context, row.displayName, verifiedThread);
    if (lateNotice === "exited") {
      list = await dump(context.serial);
      continue;
    }
    if (lateNotice === "exit-failed") break;
    const verifiedComposer = verifiedThread.nodes.find(node =>
      /edittext/i.test(node.className) && /message|chat|send/i.test(`${node.resourceId} ${node.desc}`),
    );
    const verifiedPeer = verifiedThread.nodes.some(node =>
      node.bounds[1] < 400 && normalizedText(node.text) === identity,
    );
    if (!verifiedPeer || !verifiedComposer) {
      context.onLog("Reply to Unread Chats stopped: the conversation changed while ChatGPT was drafting.");
      await exitSnapchatConversation(context).catch(() => false);
      break;
    }
    let sendState: Awaited<ReturnType<typeof dump>> | undefined;
    let enteredReply = "";
    const initialComposerText = verifiedComposer.text.trim();
    if (initialComposerText && !/^send chat$/i.test(initialComposerText)) {
      context.onLog("Reply to Unread Chats stopped: the reply field already contains a draft.");
      await exitSnapchatConversation(context).catch(() => false);
      break;
    }
    context.onLog(`Reply to Unread Chats: typing ${reply.length} characters with this device's calibrated keyboard.`);
    const { x, y } = center(verifiedComposer);
    await android.tap(context.serial, x, y, "bot", "Snapchat: focus confirmed unread-chat composer", "automation");
    try {
      const typed = await android.typeViaSavedCalibrationMap(
        context.serial,
        reply,
        context.effectiveTypingProfile(context.serial),
        message => context.onLog(`Reply to Unread Chats: ${message}`),
        { debugLabel: "Snapchat reply", disableHumanErrors: true, skipMissingKeys: true },
      );
      if (!typed.available) {
        context.onLog(
          `Reply to Unread Chats stopped: this device has no saved keyboard calibration map` +
          `${typed.missing.length ? `; missing keys: ${typed.missing.join(", ")}` : ""}.`,
        );
        await exitSnapchatConversation(context).catch(() => false);
        break;
      }
      if (typed.missing.length) {
        context.onLog(
          `Reply to Unread Chats: skipped unmapped key(s) ${[...new Set(typed.missing)].join(", ")}; continuing with the remaining calibrated keys.`,
        );
      }
      await context.sleep(450, "exact");
      sendState = await dump(context.serial);
      const composerAfterTyping = sendState.nodes.find(node =>
        /edittext/i.test(node.className) && /chat_input_text_field/i.test(node.resourceId),
      );
      enteredReply = composerAfterTyping?.text.trim() ?? "";
      if (
        !enteredReply ||
        /^send chat$/i.test(enteredReply) ||
        enteredReply === initialComposerText
      ) {
        context.onLog("Reply to Unread Chats stopped: no new reply text appeared in the composer.");
        await exitSnapchatConversation(context).catch(() => false);
        break;
      }
    } catch {
      context.onLog("Reply to Unread Chats stopped: calibrated keyboard typing failed; the reply was not sent.");
      await exitSnapchatConversation(context).catch(() => false);
      break;
    }
    context.onLog(`Reply to Unread Chats: confirmed ${enteredReply.length} characters in the composer; pressing Enter to send.`);
    try {
      await android.keyevent(context.serial, 66); // Android KEYCODE_ENTER; no per-device key mapping required.
    } catch {
      context.onLog("Reply to Unread Chats stopped: Android Enter could not be sent; the reply was not confirmed sent.");
      await exitSnapchatConversation(context).catch(() => false);
      break;
    }
    const sentState = await dump(context.serial);
    const afterConversation = visibleConversation(sentState.nodes, composer.bounds[1])
      .map(normalizedText).join(" ");
    const beforeConversation = transcript.map(normalizedText).join(" ");
    const composerAfterSend = sentState.nodes.find(node =>
      /edittext/i.test(node.className) && /chat_input_text_field/i.test(node.resourceId),
    );
    const sentTextConfirmed =
      afterConversation.includes(normalizedText(enteredReply)) &&
      !beforeConversation.includes(normalizedText(enteredReply)) &&
      (!composerAfterSend?.text.trim() || normalizedText(composerAfterSend.text) === "send chat");
    if (!sentTextConfirmed) {
      context.onLog(`Reply to Unread Chats: send could not be confirmed for ${username}; it was not added to the sent count.`);
      await exitSnapchatConversation(context).catch(() => false);
      list = await dump(context.serial);
      continue;
    }
    try {
      const record = appendSnapchatReplyHistory({
        slotId: context.slotId,
        serial: context.serial,
        username,
        displayName: row.displayName,
        capturedMessages: transcript,
        sentText: enteredReply,
        sentAt: new Date().toISOString(),
      });
      context.onLog(`Reply log saved for @${username}; confirmed sent reply #${record.replyNumber}.`);
    } catch (error) {
      context.onLog(`Reply to Unread Chats warning: the message was sent, but the local log could not be saved (${error instanceof Error ? error.message : "write failed"}).`);
    }
    replied++;
    const exitedToChatSurface = await exitSnapchatConversation(context).catch(() => false);
    if (!exitedToChatSurface) {
      context.onLog("Reply to Unread Chats stopped: could not return to Snapchat after sending the reply.");
      break;
    }
    list = await dump(context.serial);
    const chatListStillOpen =
      Boolean(exactClickable(list.nodes, ["Chat"])) &&
      !list.nodes.some(node =>
        /edittext/i.test(node.className) && /chat_input_text_field/i.test(node.resourceId),
      );
    if (!chatListStillOpen) {
      context.onLog("Reply to Unread Chats stopped: Snapchat did not return to the chat list after exiting the conversation.");
      break;
    }
    if (replied < requested) {
      context.onLog("Reply to Unread Chats: continuing in the existing Unread list without tapping Chat or Unread again.");
    }
  }
  context.onLog(`Reply to Unread Chats: confirmed ${replied}/${requested} GPT-6 Luna replies.`);
}

async function runViewSpotlights(context: Context) {
  const settings = context.tools.viewStories;
  if (!settings.enabled) return;
  const requested = randomCount(Math.max(1, settings.min), Math.max(1, settings.max));
  if (!await openSpotlight(context)) return;

  let swiped = 0;
  for (let index = 0; index < requested && !context.isAborted(); index++) {
    const state = await dump(context.serial);
    if (!isSpotlightSurface(state.xml, state.nodes)) {
      context.onLog("View Spotlights stopped: Spotlight was no longer the active screen.");
      break;
    }

    const likeChance = randomPercent(settings.likePercentMin, settings.likePercentMax);
    const roll = Math.random() * 100;
    if (roll < likeChance) {
      const favorite = state.nodes.find(node =>
        node.clickable && node.resourceId.split("/").pop() === "favorite",
      );
      if (!favorite) {
        context.onLog("View Spotlights: like chance passed, but the current media's heart button was not found.");
      } else if (favorite.selected || /\b(unlike|remove favorite)\b/i.test(nodeLabel(favorite))) {
        context.onLog("View Spotlights: current Spotlight media is already liked; leaving it unchanged.");
      } else if (!context.isAborted()) {
        const x = Math.round((favorite.bounds[0] + favorite.bounds[2]) / 2);
        const y = Math.round(favorite.bounds[1] + (favorite.bounds[3] - favorite.bounds[1]) * 0.37);
        await android.tap(context.serial, x, y, "bot", "Snapchat: like current Spotlight media", "automation");
        await context.sleep(500);
        context.onLog(`View Spotlights: liked current media (roll ${roll.toFixed(1)} < ${likeChance}%).`);
      }
    } else {
      context.onLog(`View Spotlights: skipped like on current media (roll ${roll.toFixed(1)} ≥ ${likeChance}%).`);
    }

    const seconds = randomSeconds(settings.watchSecondsMin, settings.watchSecondsMax);
    context.onLog(`View Spotlights: waiting ${seconds}s before the next Spotlight swipe.`);
    await context.sleep(seconds * 1000);
    if (context.isAborted() || !await swipeByDeviceGesture(context)) break;
    await context.sleep(900);
    const afterSwipe = await dump(context.serial);
    if (!isSpotlightSurface(afterSwipe.xml, afterSwipe.nodes)) {
      context.onLog("View Spotlights stopped: the screen left Spotlight after the swipe.");
      break;
    }
    swiped++;
  }
  context.onLog(`View Spotlights: completed ${swiped}/${requested} Spotlight swipe(s).`);
}

async function runViewSnaps(context: Context) {
  const settings = context.tools.viewSnaps;
  if (!settings.enabled) return;
  const requested = randomCount(Math.max(1, settings.min), Math.max(1, settings.max));
  if (!await openStories(context)) return;

  const stories = await dump(context.serial);
  const { h: screenHeight, w: screenWidth } = await android.getScreenSizeAsync(context.serial);
  const circles = findStoryCircles(stories.nodes, screenHeight);
  if (circles.length === 0) {
    context.onLog("View Snaps stopped: no circular stories were found under Friends.");
    return;
  }
  const story = circles[Math.floor(Math.random() * circles.length)];
  if (!await tapNode(context, story, "open a circular story")) return;

  let state = await dump(context.serial);
  if (!isSnapMediaViewer(state.xml, state.nodes)) {
    context.onLog("View Snaps stopped: Snapchat's story viewer was not confirmed after opening a story.");
    return;
  }

  let viewed = 1;
  for (let index = 1; index < requested && !context.isAborted(); index++) {
    const seconds = randomSeconds(settings.watchSecondsMin, settings.watchSecondsMax);
    context.onLog(`View Snaps: waiting ${seconds}s before the next Snap tap.`);
    await context.sleep(seconds * 1000);
    if (context.isAborted()) break;

    state = await dump(context.serial);
    if (!isSnapMediaViewer(state.xml, state.nodes)) {
      context.onLog("View Snaps stopped: the Snapchat story viewer was no longer active.");
      break;
    }
    const x = Math.round(screenWidth * 0.86);
    const y = Math.round(screenHeight * 0.5);
    await android.tap(context.serial, x, y, "bot", "Snapchat: advance to next Snap on right side", "automation");
    await context.sleep(700);
    state = await dump(context.serial);
    if (!isSnapMediaViewer(state.xml, state.nodes)) {
      context.onLog("View Snaps stopped: the story viewer closed after the right-side tap.");
      break;
    }
    viewed++;
  }
  context.onLog(`View Snaps: viewed ${viewed}/${requested} Snap(s).`);
}

async function returnToCameraBeforeNextTool(context: Context): Promise<boolean> {
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

export async function runSnapchatTools(context: Context): Promise<void> {
  const orderedTools = [
    { name: "Add Friends", settings: context.tools.addFriends, run: () => runAddFriends(context) },
    { name: "Accept Friends", settings: context.tools.acceptFriends, run: () => runAcceptFriends(context) },
    { name: "Reply to Unread Chats", settings: context.tools.replyUnreadChats, run: () => runReplyUnreadChats(context) },
    { name: "View Spotlights", settings: context.tools.viewStories, run: () => runViewSpotlights(context) },
    { name: "View Snaps", settings: context.tools.viewSnaps, run: () => runViewSnaps(context) },
  ].filter(tool => {
    if (!tool.settings.enabled) return false;
    const min = Math.max(0, Math.min(100, Math.round(tool.settings.activatePctMin)));
    const max = Math.max(0, Math.min(100, Math.round(tool.settings.activatePctMax)));
    const low = Math.min(min, max);
    const high = Math.max(min, max);
    const chance = Math.round(low + Math.random() * (high - low));
    const activated = Math.random() * 100 < chance;
    context.onLog(`[Snapchat activation] ${tool.name}: ${activated ? "activated" : "skipped"} (${chance}%)`);
    return activated;
  });

  if (context.tools.shuffleToolOrder) {
    for (let i = orderedTools.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [orderedTools[i], orderedTools[j]] = [orderedTools[j], orderedTools[i]];
    }
    context.onLog(`Snapchat tool order shuffled: ${orderedTools.length ? orderedTools.map(tool => tool.name).join(" → ") : "(no tools activated)"}`);
  }

  for (let index = 0; index < orderedTools.length; index++) {
    const tool = orderedTools[index];
    if (context.isAborted()) return;
    let toolError: unknown;
    let toolFailed = false;
    try {
      await tool.run();
    } catch (error) {
      toolError = error;
      toolFailed = true;
    }
    if ((tool.name === "Add Friends" || tool.name === "Accept Friends") && !context.isAborted()) {
      if (!await collapseAddFriendsBeforeNextTool(context)) return;
    }
    if (toolFailed) throw toolError;
    if (index < orderedTools.length - 1 &&
        (tool.name === "View Spotlights" || tool.name === "View Snaps")) {
      if (context.isAborted()) return;
      if (!await returnToCameraBeforeNextTool(context)) return;
    }
  }
}
