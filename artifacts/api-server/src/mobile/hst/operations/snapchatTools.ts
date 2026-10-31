import * as android from "../../androidManager";
import { storage } from "../../../storage";
import {
  appendSnapchatReplyHistory,
  containsSnapchatBoundlusLink,
  getSnapchatReplyHistory,
  isBoundlusClarificationQuestion,
} from "../../snapchatReplyHistory";
import { generateSnapchatLunaReply } from "../../snapchatLuna";

type SnapchatTools = {
  shuffleToolOrder: boolean;
  uploadSnap: {
    enabled: boolean; min: number; max: number;
    activatePctMin: number; activatePctMax: number;
    directoryPath: string; selectAtRandom: boolean;
  };
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
  focusable: boolean;
  focused: boolean;
  selected: boolean;
  bounds: [number, number, number, number];
};

type Context = {
  serial: string;
  slotId?: string;
  slotIdx?: number;
  path: any;
  pickLocalFolderImage: (
    serial: string,
    opts: {
      folderPath: string;
      random: boolean;
      noRepeat: boolean;
      slotIdx?: number;
      onLog?: (message: string) => void;
    },
  ) => Promise<string | null>;
  tools: SnapchatTools;
  onLog: (message: string) => void;
  onProgress: () => void;
  onMetric?: (key: "snapchat_add_friends" | "snapchat_accept_friends" | "snapchat_replies" | "snapchat_spotlights" | "snapchat_snaps", count?: number) => void;
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
      focusable: get("focusable") === "true",
      focused: get("focused") === "true",
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

async function tapNode(context: Context, node: UiNode, reason: string, settleMs = 700, exact = false) {
  if (context.isAborted()) return false;
  const { x, y } = center(node);
  await android.tap(
    context.serial, x, y, "bot", `Snapchat: ${reason}`, "automation",
    exact ? { exact: true } : undefined,
  );
  if (settleMs > 0) await context.sleep(settleMs);
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

function hasSnapchatChatComposer(nodes: UiNode[]): boolean {
  return nodes.some(node =>
    /edittext/i.test(node.className) && /chat_input_text_field/i.test(node.resourceId),
  );
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

type TabActivationResult = "activated" | "covered" | "surface-changed" | "not-focusable" | "focus-not-reached";

async function activateFocusedNodeWithTab(
  context: Context,
  findTarget: (nodes: UiNode[]) => UiNode | undefined,
  isExpectedSurface: (xml: string) => boolean,
  screenWidth: number,
  screenHeight: number,
  reason: string,
): Promise<TabActivationResult> {
  const maxTabSteps = 8;
  let previousFocus = "";

  for (let tabStep = 0; tabStep <= maxTabSteps && !context.isAborted(); tabStep++) {
    const state = await dump(context.serial);
    if (!isExpectedSurface(state.xml)) return "surface-changed";

    const target = findTarget(state.nodes);
    if (!target) return "focus-not-reached";
    if (findOccludingBanner(state.nodes, target, screenWidth, screenHeight)) return "covered";
    if (target.focused) {
      context.onLog(`Snapchat: Android keyboard focus is on the intended ${reason}; activating with Enter instead of a coordinate tap.`);
      await android.keyevent(context.serial, 66); // KEYCODE_ENTER
      return "activated";
    }
    if (!target.focusable) return "not-focusable";
    if (tabStep === maxTabSteps) return "focus-not-reached";

    const focused = state.nodes.find(node => node.focused);
    const focusSignature = focused
      ? `${focused.resourceId}|${focused.text}|${focused.desc}|${focused.bounds.join(",")}`
      : "<no-focused-node>";
    if (tabStep > 0 && focusSignature === previousFocus) return "focus-not-reached";
    previousFocus = focusSignature;
    await android.keyevent(context.serial, 61); // KEYCODE_TAB
  }

  return "focus-not-reached";
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
  let chatKeyboardDismissAttempted = false;
  let chatExitAttempted = false;
  while (!context.isAborted()) {
    const state = await dump(context.serial);
    if (isAddFriendsPage(state.xml)) return true;

    const chatComposer = hasSnapchatChatComposer(state.nodes);
    if (chatComposer) {
      const keyboardShown = await android.isKeyboardShown(context.serial).catch(() => false);
      if (keyboardShown) {
        if (chatKeyboardDismissAttempted) {
          context.onLog("Snapchat stopped: the chat keyboard stayed open after one Back press; refusing to navigate from an unverified surface.");
          return false;
        }
        chatKeyboardDismissAttempted = true;
        context.onLog("Snapchat: dismissing the open chat keyboard before returning to Camera.");
        await android.keyevent(context.serial, 4); // Android KEYCODE_BACK
        await context.sleep(300, "exact");
        continue;
      }

      if (chatExitAttempted) {
        context.onLog("Snapchat stopped: the active chat remained open after one Back press; refusing to continue on the wrong screen.");
        return false;
      }
      chatExitAttempted = true;
      context.onLog("Snapchat: leaving the verified open chat before returning to Camera.");
      await android.keyevent(context.serial, 4); // Android KEYCODE_BACK
      await context.sleep(400, "exact");
      const afterBack = await dump(context.serial);
      const composerStillOpen = hasSnapchatChatComposer(afterBack.nodes);
      if (composerStillOpen) {
        context.onLog("Snapchat stopped: Android Back did not close the active chat.");
        return false;
      }
      chatKeyboardDismissAttempted = false;
      continue;
    }

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
    const focusResult = await activateFocusedNodeWithTab(
      context,
      nodes => nodes.find(node => shortResourceId(node) === "neon_add_friend_button_container"),
      xml => /camera_page/i.test(xml) && !/add_friends_root/i.test(xml),
      screenWidth,
      screenHeight,
      "person-plus control",
    );
    if (focusResult === "covered") {
      if (!bannerWaitLogged) {
        context.onLog("Add Friends: waiting for the top-right control to clear before activating it.");
        bannerWaitLogged = true;
      }
      await context.sleep(BANNER_RECHECK_MS, "exact");
      continue;
    }
    if (focusResult === "surface-changed") continue;
    if (focusResult !== "activated") {
      const fresh = await dump(context.serial);
      if (!/camera_page/i.test(fresh.xml) || /add_friends_root/i.test(fresh.xml)) continue;
      const liveIcon = fresh.nodes.find(node =>
        shortResourceId(node) === "neon_add_friend_button_container",
      );
      if (!liveIcon) continue;
      if (findOccludingBanner(fresh.nodes, liveIcon, screenWidth, screenHeight)) {
        await context.sleep(BANNER_RECHECK_MS, "exact");
        continue;
      }
      if (!await tapNode(
        context,
        liveIcon,
        "open Add Friends from the top-right person-plus icon",
        700,
        true,
      )) return false;
    }
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
  const low = Math.max(0, Math.trunc(Math.min(min, max)));
  const high = Math.max(low, Math.trunc(Math.max(min, max)));
  return low + Math.floor(Math.random() * (high - low + 1));
}

type UploadSnapResult = "not-started" | "selected" | "failed";

async function runUploadSnap(context: Context): Promise<UploadSnapResult> {
  const settings = context.tools.uploadSnap;
  if (!settings.enabled || !settings.directoryPath.trim()) return "not-started";

  const fileName = await context.pickLocalFolderImage(context.serial, {
    folderPath: settings.directoryPath,
    random: settings.selectAtRandom,
    noRepeat: false,
    slotIdx: context.slotIdx,
    onLog: message => context.onLog(message.replace(/^Make a Post:/, "Upload a Snap:")),
  });
  if (!fileName) return "not-started";

  const localFilePath = context.path.join(settings.directoryPath, fileName);
  let devicePath = "";
  try {
    context.onLog(`Upload a Snap: pushing "${fileName}" to the phone gallery before opening Snapchat Memories.`);
    devicePath = await android.pushFileToDevice(
      context.serial,
      localFilePath,
      fileName,
      true,
      true,
    );
    context.onLog(`Upload a Snap: phone gallery copy staged and scanned (${devicePath}).`);
    await context.sleep(1000, "exact");

    let state = await dump(context.serial);
    if (!/id="camera_page"/i.test(state.xml)) {
      const cameraTab = exactClickable(state.nodes, ["Camera"]);
      if (!cameraTab || !await tapNode(context, cameraTab, "open Snapchat Camera before Upload a Snap")) {
        context.onLog("Upload a Snap stopped: Snapchat's Camera tab was not available.");
        await android.removeDeviceFile(context.serial, devicePath).catch(() => {});
        return "failed";
      }
      let cameraReady = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        state = await dump(context.serial);
        if (/id="camera_page"/i.test(state.xml)) {
          cameraReady = true;
          break;
        }
        if (attempt < 9) await context.sleep(500, "exact");
      }
      if (!cameraReady) {
        context.onLog("Upload a Snap stopped: Snapchat's Camera screen was not confirmed after tapping Camera.");
        await android.removeDeviceFile(context.serial, devicePath).catch(() => {});
        return "failed";
      }
    } else {
      context.onLog("Upload a Snap: Snapchat is already on the Camera screen.");
    }

    const memoriesIcon = state.nodes.find(node =>
      shortResourceId(node) === "ngs_memories_icon" ||
      node.desc.trim().toLowerCase() === "memories",
    );
    if (!memoriesIcon || !await tapNode(context, memoriesIcon, "open Memories from the Camera screen")) {
      context.onLog("Upload a Snap stopped: the Memories icon was not available on the Camera screen.");
      await android.removeDeviceFile(context.serial, devicePath).catch(() => {});
      return "failed";
    }

    let memoriesReady = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      state = await dump(context.serial);
      if (/id="memories_grid"/i.test(state.xml)) {
        memoriesReady = true;
        break;
      }
      if (attempt < 9) await context.sleep(500, "exact");
    }
    if (!memoriesReady) {
      context.onLog("Upload a Snap stopped: Snapchat Memories did not open after tapping its Camera icon.");
      await android.removeDeviceFile(context.serial, devicePath).catch(() => {});
      return "failed";
    }

    const cameraRollTab = state.nodes.find(node =>
      node.text.trim().toLowerCase() === "camera roll" ||
      node.desc.trim().toLowerCase() === "camera roll",
    );
    if (!cameraRollTab || !await tapNode(context, cameraRollTab, "open the Camera Roll tab")) {
      context.onLog("Upload a Snap stopped: the Camera Roll tab was not available in Memories.");
      await android.removeDeviceFile(context.serial, devicePath).catch(() => {});
      return "failed";
    }

    let galleryReady = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      state = await dump(context.serial);
      if (/id="grid_frameable_container"/i.test(state.xml)) {
        galleryReady = true;
        break;
      }
      if (attempt < 9) await context.sleep(500, "exact");
    }
    if (!galleryReady) {
      context.onLog("Upload a Snap stopped: no Camera Roll gallery image was available to select.");
      await android.removeDeviceFile(context.serial, devicePath).catch(() => {});
      return "failed";
    }

    const firstImage = state.nodes
      .filter(node => shortResourceId(node) === "grid_frameable_container")
      .sort((a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0])[0];
    if (!firstImage || !await tapNode(context, firstImage, "select the first Camera Roll gallery image")) {
      context.onLog("Upload a Snap stopped: the first Camera Roll image could not be selected.");
      await android.removeDeviceFile(context.serial, devicePath).catch(() => {});
      return "failed";
    }

    let imageOpened = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      state = await dump(context.serial);
      if (!/id="memories_grid"/i.test(state.xml)) {
        imageOpened = true;
        break;
      }
      if (attempt < 9) await context.sleep(500, "exact");
    }
    if (!imageOpened) {
      context.onLog("Upload a Snap stopped: tapping the first image did not leave the Camera Roll; no further control was guessed.");
      await android.removeDeviceFile(context.serial, devicePath).catch(() => {});
      return "failed";
    }

    context.onLog(`Upload a Snap: selected the first Camera Roll image from "${fileName}". Leaving Snapchat on this screen for testing.`);
    return "selected";
  } catch (error) {
    context.onLog(`Upload a Snap stopped: ${error instanceof Error ? error.message : "image staging or navigation failed"}.`);
    if (devicePath) await android.removeDeviceFile(context.serial, devicePath).catch(() => {});
    return "failed";
  }
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
const isMyAiChat = (name: string) => normalizedText(name) === "my ai";

function findPostLinkMessage(
  transcript: string[],
  linkReply: { capturedMessages: string[] },
): string {
  const beforeLink = new Set(linkReply.capturedMessages.map(normalizedText));
  return transcript
    .filter(message =>
      !beforeLink.has(normalizedText(message)) &&
      !containsSnapchatBoundlusLink(message)
    )
    .at(-1) ?? "";
}

async function pressAndroidBack(context: Context, count: number, action: string): Promise<boolean> {
  for (let press = 0; press < count; press++) {
    if (context.isAborted()) return false;
    try {
      await android.keyevent(context.serial, 4); // Android KEYCODE_BACK
    } catch {
      context.onLog(`Snapchat: Android Back failed while ${action}.`);
      return false;
    }
    if (press + 1 < count) await context.sleep(200, "exact");
  }
  return true;
}

async function exitSnapchatConversation(context: Context): Promise<boolean> {
  const hasComposer = (state: Awaited<ReturnType<typeof dump>>) => state.nodes.some(node =>
    /edittext/i.test(node.className) && /chat_input_text_field/i.test(node.resourceId),
  );
  const isChatTab = (state: Awaited<ReturnType<typeof dump>>) =>
    Boolean(exactClickable(state.nodes, ["Chat"]));

  let state = await dump(context.serial);
  if (!hasComposer(state) && !hasNotAddedFriendNotice(state)) {
    context.onLog("Reply to Unread Chats: refusing Android Back because the current surface is not a confirmed conversation.");
    return false;
  }

  context.onLog("Reply to Unread Chats: exiting the confirmed conversation one Android Back press at a time.");
  for (let press = 1; press <= 2; press++) {
    if (context.isAborted()) return false;
    try {
      await android.keyevent(context.serial, 4); // Android KEYCODE_BACK
    } catch {
      context.onLog(`Snapchat: Android Back failed while exiting the conversation (press ${press}).`);
      return false;
    }
    await context.sleep(250, "exact");
    state = await dump(context.serial);

    const composerVisible = hasComposer(state);
    const chatTabVisible = isChatTab(state);
    if (chatTabVisible && !composerVisible) {
      context.onLog(`Reply to Unread Chats: conversation exit verified after ${press} Back press(es); chatTab=true, composer=false.`);
      return true;
    }
    if (!composerVisible && !hasNotAddedFriendNotice(state)) {
      context.onLog(`Reply to Unread Chats: stopped after ${press} Back press(es); the conversation closed without confirming the Chat tab, so no further Back was sent.`);
      return false;
    }
  }

  context.onLog("Reply to Unread Chats: the conversation was still open after two verified Back presses.");
  return false;
}

async function recoverFromUnreadSnapViewer(
  context: Context,
  displayName: string,
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

  const returnedToConversation = state.nodes.some(node =>
    /edittext/i.test(node.className) && /chat_input_text_field/i.test(node.resourceId),
  );
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
  context.onLog(`Reply to Unread Chats: Snapchat says ${displayName} has not added this account; skipping the reply and exiting with two Android Back presses.`);
  const exited = await exitSnapchatConversation(context).catch(() => false);
  if (!exited) {
    context.onLog(`Reply to Unread Chats stopped: could not exit ${displayName}'s conversation after Snapchat showed the friend notice.`);
    return "exit-failed";
  }
  return "exited";
}

function unreadChatRows(nodes: UiNode[]) {
  return nodes.flatMap(marker => {
    const markerLabel = `${marker.text} ${marker.desc}`.trim();
    if (!/ff_item/i.test(shortResourceId(marker))) return [];
    const rowHeight = marker.bounds[3] - marker.bounds[1];
    const rowNodes = nodes.filter(node =>
      node.bounds[0] >= marker.bounds[0] &&
      node.bounds[1] >= marker.bounds[1] &&
      node.bounds[2] <= marker.bounds[2] &&
      node.bounds[3] <= marker.bounds[3],
    );
    const rowLabel = [markerLabel, ...rowNodes.map(nodeLabel)].join(" ");
    const hasMedia = /\b(snaps?|photos?|videos?)\b/i.test(rowLabel);
    const hasChats = /\bchats?\b/i.test(rowLabel);
    const chatActionNode = rowNodes.find(node =>
      /feed_chat_button/i.test(`${node.text} ${node.desc} ${node.resourceId}`) &&
      node.bounds[0] >= marker.bounds[0] + rowHeight * 0.65,
    );
    // Pure photo/video/Snap rows still open media and must be ignored. A
    // mixed "Snaps and Chats" row is safe only when Snapchat exposes its
    // separate chat-only action at the far right of that same row.
    if (hasMedia && !(hasChats && chatActionNode)) return [];
    const names = nodes.filter(node =>
      node.text.trim() &&
      node.bounds[1] >= marker.bounds[1] &&
      node.bounds[3] <= marker.bounds[3] &&
      node.bounds[1] < marker.bounds[1] + rowHeight * 0.48 &&
      !/^(unread|received|sent|opened|new|camera|chat)$/i.test(node.text.trim()),
    ).sort((a, b) => a.bounds[1] - b.bounds[1]);
    const nameNode = names[0];
    const displayName = nameNode?.text.trim();
    if (displayName && isMyAiChat(displayName)) return [];
    return nameNode && displayName
      ? [{ marker, nameNode, displayName, chatActionNode: hasMedia ? chatActionNode : undefined }]
      : [];
  });
}

async function tapUnreadChatNameArea(
  context: Context,
  row: ReturnType<typeof unreadChatRows>[number],
  screenWidth: number,
): Promise<boolean> {
  if (context.isAborted()) return false;
  if (isMyAiChat(row.displayName)) {
    context.onLog("Reply to Unread Chats: refusing to open Snapchat's My AI chat.");
    return false;
  }
  if (row.chatActionNode) {
    const { x, y } = center(row.chatActionNode);
    context.onLog(`Reply to Unread Chats: "${row.displayName}" has mixed media and chat activity; tapping its chat-only right-side icon at (${x},${y}).`);
    await android.tap(context.serial, x, y, "bot", `Snapchat: open chat-only action for ${row.displayName}`, "automation");
    await context.sleep(700);
    return !context.isAborted();
  }
  const [rowLeft, rowTop, rowRight, rowBottom] = row.marker.bounds;
  const rowWidth = rowRight - rowLeft;
  // The ff_item node normally spans the full chat row. If Snapchat exposes a
  // narrower marker node, use the screen midpoint instead. Both positions land
  // between the avatar on the left and the action icon on the right.
  const x = Math.round(rowWidth >= screenWidth * 0.6 ? rowLeft + rowWidth / 2 : screenWidth / 2);
  const nameCenter = center(row.nameNode);
  const y = Math.max(rowTop + 1, Math.min(rowBottom - 1, nameCenter.y));
  context.onLog(`Reply to Unread Chats: tapping the central name area for "${row.displayName}" at (${x},${y}), between the avatar and right-side icon.`);
  await android.tap(context.serial, x, y, "bot", `Snapchat: open unread chat for ${row.displayName}`, "automation");
  await context.sleep(700);
  return !context.isAborted();
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

async function runAddFriends(context: Context): Promise<"surface-lost" | void> {
  const requested = randomCount(context.tools.addFriends.min, context.tools.addFriends.max);
  if (!context.tools.addFriends.enabled || requested === 0) return;
  if (!await openAddFriends(context)) return;
  const { w: screenWidth, h: screenHeight } = await android.getScreenSizeAsync(context.serial);
  let added = 0;
  let blockedFriend = "";
  let surfaceLost = false;
  const attemptedFriends = new Set<string>();
  const findAddCandidates = (nodes: UiNode[]) => {
    const findFriendsStart = nodes.findIndex(node =>
      shortResourceId(node) === "section-title" &&
      [node.text, node.desc].some(value => /^find friends$/i.test(value.trim())),
    );
    if (findFriendsStart < 0) {
      return {
        findFriendsStart,
        addButtons: [] as UiNode[],
        candidates: [] as Array<{ candidate: UiNode; friendName: string; friendKey: string }>,
      };
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
    const candidates = addButtons.flatMap(candidate => {
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
      const friendKey = friendName.toLowerCase().replace(/\s+/g, " ").trim();
      return friendName ? [{ candidate, friendName, friendKey }] : [];
    });
    return { findFriendsStart, addButtons, candidates };
  };
  while (added < requested && !context.isAborted()) {
    const { xml, nodes } = await dump(context.serial);
    if (!isAddFriendsPage(xml)) {
      context.onLog("Add Friends stopped: the verified Add Friends page is no longer open.");
      break;
    }
    const { findFriendsStart, addButtons, candidates } = findAddCandidates(nodes);
    if (findFriendsStart < 0) {
      context.onLog("Add Friends stopped: the Find Friends section title was not found.");
      break;
    }
    const selected = candidates.find(({ friendKey }) => !attemptedFriends.has(friendKey));
    const candidate = selected?.candidate;
    if (!selected || !candidate) {
      context.onLog(addButtons.length
        ? "Add Friends: no unattempted Add rows remain; continuing to the next tool."
        : "Add Friends: no Add button remains under Find Friends; continuing to the next tool.");
      break;
    }
    const { friendName, friendKey } = selected;
    const focusResult = await activateFocusedNodeWithTab(
      context,
      nodes => findAddCandidates(nodes).candidates.find(item => item.friendKey === friendKey)?.candidate,
      isAddFriendsPage,
      screenWidth,
      screenHeight,
      `Add for ${friendName}`,
    );
    if (context.isAborted()) break;
    if (focusResult === "covered") {
      if (blockedFriend !== friendName) {
        blockedFriend = friendName;
        context.onLog(`Add Friends: waiting for the banner to clear Add for ${friendName}.`);
      }
      await context.sleep(BANNER_RECHECK_MS, "exact");
      continue;
    }
    if (focusResult === "surface-changed") {
      context.onLog("Add Friends stopped: Snapchat left the verified friend list; no other Snapchat tool will run on that screen.");
      surfaceLost = true;
      break;
    }

    blockedFriend = "";
    if (focusResult !== "activated") {
      // Keyboard focus is preferred because a banner cannot steal a key event
      // by covering the Add button. If Snapchat does not expose this control
      // to Tab navigation, take one final live snapshot before the coordinate
      // fallback.
      const latest = await dump(context.serial);
      if (!isAddFriendsPage(latest.xml)) {
        context.onLog("Add Friends stopped: Snapchat left the verified friend list before input.");
        surfaceLost = true;
        break;
      }
      const liveSelection = findAddCandidates(latest.nodes).candidates.find(
        item => item.friendKey === friendKey,
      );
      if (!liveSelection) continue;
      if (findOccludingBanner(latest.nodes, liveSelection.candidate, screenWidth, screenHeight)) {
        if (blockedFriend !== friendName) {
          blockedFriend = friendName;
          context.onLog(`Add Friends: waiting for the banner to clear Add for ${friendName}.`);
        }
        await context.sleep(BANNER_RECHECK_MS, "exact");
        continue;
      }
      if (!await tapNode(
        context,
        liveSelection.candidate,
        `tap Add for ${friendName} under Find Friends`,
        0,
        true,
      )) break;
    }

    const afterTap = await dump(context.serial);
    if (hasSnapchatChatComposer(afterTap.nodes) || !isAddFriendsPage(afterTap.xml)) {
      context.onLog(`Add Friends stopped: Snapchat left the friend list while processing ${friendName}; stopping the tool sequence instead of entering the banner's chat.`);
      surfaceLost = true;
      break;
    }
    attemptedFriends.add(friendKey);
    added++;
    context.onMetric?.("snapchat_add_friends");
    context.onLog(`Add Friends: tapped Add for ${friendName}; continuing without waiting for Snapchat's confirmation.`);
  }
  context.onLog(`Add Friends: processed ${added}/${requested} Add tap(s) from the Find Friends section.`);
  return surfaceLost ? "surface-lost" : undefined;
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
      context.onMetric?.("snapchat_accept_friends");
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
  const current = await dump(context.serial);
  if (/camera_page/i.test(current.xml) && !/add_friends_root/i.test(current.xml)) return true;
  if (!/add_friends_root/i.test(current.xml)) {
    context.onLog("Snapchat: cannot close Add Friends because its panel is not confirmed.");
    return false;
  }
  if (!await pressAndroidBack(context, 1, "closing the Add Friends panel")) return false;
  await context.sleep(200, "exact");
  const after = await dump(context.serial);
  if (/camera_page/i.test(after.xml) && !/add_friends_root/i.test(after.xml)) {
    context.onLog("Snapchat: returned to Camera with Android Back.");
    return true;
  }
  context.onLog("Snapchat stopped: Android Back did not close the Add Friends panel.");
  return false;
}

async function runReplyUnreadChats(context: Context) {
  const { enabled, replyGoal } = context.tools.replyUnreadChats;
  const requested = randomCount(context.tools.replyUnreadChats.min, context.tools.replyUnreadChats.max);
  if (!enabled || requested === 0) return;
  context.onLog(`Reply to Unread Chats: target ${requested} unread contact(s), one reply per contact.`);
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
  const { w: screenWidth } = await android.getScreenSizeAsync(context.serial);

  let replied = 0;
  const visited = new Set<string>();
  while (replied < requested && !context.isAborted()) {
    let rows = unreadChatRows(list.nodes);
    // Snapchat can take a moment to repopulate the Unread list after Back.
    // Re-dump briefly before treating an empty accessibility snapshot as the
    // end of the list; membership in the Unread tab is the unread signal, not
    // whether the row's status happens to say "New Chat".
    for (let retry = 0; rows.length === 0 && retry < 4 && !context.isAborted(); retry++) {
      await context.sleep(500, "exact");
      list = await dump(context.serial);
      rows = unreadChatRows(list.nodes);
    }
    context.onLog(`Reply to Unread Chats: found ${rows.length} eligible text-chat row(s) in the Unread list.`);
    const row = rows.find(item => !visited.has(normalizedText(item.displayName)));
    if (!row) {
      context.onLog("Reply to Unread Chats: no eligible text-chat row remains in Snapchat's Unread list.");
      break;
    }
    const identity = normalizedText(row.displayName);
    if (visited.has(identity)) break;
    visited.add(identity);
    context.onLog(`Reply to Unread Chats: noted unread contact name "${row.displayName}" from the list.`);
    if (!await tapUnreadChatNameArea(context, row, screenWidth)) break;
    const openedThread = await dump(context.serial);
    const snapRecovery = await recoverFromUnreadSnapViewer(
      context,
      row.displayName,
      openedThread,
    );
    if (snapRecovery.detected) {
      if (!snapRecovery.list) break;
      list = snapRecovery.list;
      continue;
    }
    const openedNotice = await handleNotAddedFriendNotice(context, row.displayName, openedThread);
    if (openedNotice === "exited") {
      list = await dump(context.serial);
      continue;
    }
    if (openedNotice === "exit-failed") break;
    const contactKey = row.displayName;
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
    if (!composer) {
      context.onLog("Reply to Unread Chats stopped: the chat composer was not available after opening the noted unread contact.");
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
    const history = getSnapchatReplyHistory(context.slotId, contactKey);
    const linkReplyIndex = history.sentReplies.findIndex(entry =>
      containsSnapchatBoundlusLink(entry.sentText),
    );
    if (linkReplyIndex >= 0) {
      const alreadyAnswered = history.sentReplies.slice(linkReplyIndex + 1).length > 0;
      const postLinkMessage = findPostLinkMessage(transcript, history.sentReplies[linkReplyIndex]);
      if (alreadyAnswered || !isBoundlusClarificationQuestion(postLinkMessage)) {
        context.onLog(
          alreadyAnswered
            ? `Reply to Unread Chats skipped for ${row.displayName}: the one post-link clarification was already used.`
            : `Reply to Unread Chats skipped for ${row.displayName}: the Boundlus link was already sent and the latest message is not a Boundlus question.`,
        );
        await exitSnapchatConversation(context).catch(() => false);
        list = await dump(context.serial);
        continue;
      }
      context.onLog(`Reply to Unread Chats: ${row.displayName} asked what Boundlus is; allowing the one post-link clarification.`);
    } else if (history.previousReplyCount >= 3) {
      context.onLog(`Reply to Unread Chats skipped for ${row.displayName}: the three ordinary replies have already been used.`);
      await exitSnapchatConversation(context).catch(() => false);
      list = await dump(context.serial);
      continue;
    }
    try {
      reply = await generateContextualReply(replyGoal, contactKey, transcript, history);
    } catch (error) {
      context.onLog(`Reply to Unread Chats skipped: ${error instanceof Error ? error.message : "GPT-6 Luna could not draft a reply."}`);
      await exitSnapchatConversation(context).catch(() => false);
      break;
    }
    if (!reply) {
      context.onLog(`Reply to Unread Chats: GPT-6 Luna deferred the reply for ${row.displayName}.`);
      await exitSnapchatConversation(context).catch(() => false);
      list = await dump(context.serial);
      continue;
    }
    context.onLog(`Luna draft (not sent yet): ${reply.replace(/[\r\n]+/g, " ")}`);
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
    if (!verifiedComposer) {
      context.onLog("Reply to Unread Chats stopped: the chat composer was no longer available after ChatGPT finished drafting.");
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
    context.onLog("Reply to Unread Chats: typing Luna's draft into the composer focused by opening the chat.");
    try {
      const typed = await android.typeViaSavedCalibrationMap(
        context.serial,
        reply,
        context.effectiveTypingProfile(context.serial),
        message => context.onLog(`Reply to Unread Chats: ${message}`),
        {
          debugLabel: "Snapchat reply",
          disableHumanErrors: true,
          skipMissingKeys: true,
          compactLogs: true,
          onProgress: context.onProgress,
          batchTaps: true,
        },
      );
      if (!typed.available) {
        context.onLog(
          `Reply to Unread Chats stopped: this device has no saved keyboard calibration map` +
          `${typed.missing.length ? `; missing keys: ${typed.missing.join(", ")}` : ""}.`,
        );
        await exitSnapchatConversation(context).catch(() => false);
        break;
      }
      if (typed.fatal) {
        context.onLog(
          typed.missing.includes("abc")
            ? "Reply to Unread Chats stopped: this device's ABC key is not calibrated; the partial draft was not sent."
            : "Reply to Unread Chats stopped: the calibrated keyboard could not return to letters; the partial draft was not sent.",
        );
        await exitSnapchatConversation(context).catch(() => false);
        break;
      }
      if (typed.missing.length) {
        context.onLog(
          `Reply to Unread Chats: skipped unmapped key(s) ${[...new Set(typed.missing)].join(", ")}; continuing with the remaining calibrated keys.`,
        );
      }
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
    context.onLog("Reply to Unread Chats: draft verified in the composer; sending.");
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
      context.onLog(`Reply to Unread Chats: send could not be confirmed for ${row.displayName}; it was not added to the sent count.`);
      await exitSnapchatConversation(context).catch(() => false);
      list = await dump(context.serial);
      continue;
    }
    try {
      const record = appendSnapchatReplyHistory({
        slotId: context.slotId,
        serial: context.serial,
        username: contactKey,
        displayName: row.displayName,
        capturedMessages: transcript,
        sentText: enteredReply,
        sentAt: new Date().toISOString(),
      });
      context.onLog(`Reply log saved for ${row.displayName}; confirmed sent reply #${record.replyNumber}.`);
    } catch (error) {
      context.onLog(`Reply to Unread Chats warning: the message was sent, but the local log could not be saved (${error instanceof Error ? error.message : "write failed"}).`);
    }
    replied++;
    context.onMetric?.("snapchat_replies");
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
    context.onMetric?.("snapchat_spotlights");

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
  context.onMetric?.("snapchat_snaps");
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
    context.onMetric?.("snapchat_snaps");
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

export async function runSnapchatTools(context: Context): Promise<boolean> {
  const orderedTools = [
    { name: "Upload a Snap", settings: context.tools.uploadSnap, run: () => runUploadSnap(context) },
    { name: "Add Friends", settings: context.tools.addFriends, run: () => runAddFriends(context) },
    { name: "Accept Friends", settings: context.tools.acceptFriends, run: () => runAcceptFriends(context) },
    { name: "Reply to Unread Chats", settings: context.tools.replyUnreadChats, run: () => runReplyUnreadChats(context) },
    { name: "View Spotlights", settings: context.tools.viewStories, run: () => runViewSpotlights(context) },
    { name: "View Snaps", settings: context.tools.viewSnaps, run: () => runViewSnaps(context) },
  ].filter(tool => {
    if (!tool.settings.enabled) return false;
    if (
      tool.name === "Upload a Snap" &&
      !(tool.settings as SnapchatTools["uploadSnap"]).directoryPath.trim()
    ) return false;
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
    if (context.isAborted()) return false;
    let toolError: unknown;
    let toolFailed = false;
    try {
      const result = await tool.run();
      if (tool.name === "Add Friends" && result === "surface-lost") return false;
      if (tool.name === "Upload a Snap") {
        // This staged test flow intentionally leaves Snapchat on the selected
        // image. Do not run later shuffled tools against the editor surface.
        if (result === "selected" || result === "failed") {
          return result === "selected";
        }
      }
    } catch (error) {
      toolError = error;
      toolFailed = true;
    }
    if ((tool.name === "Add Friends" || tool.name === "Accept Friends") && !context.isAborted()) {
      if (!await collapseAddFriendsBeforeNextTool(context)) return false;
    }
    if (
      tool.name === "Reply to Unread Chats" &&
      !toolFailed &&
      index < orderedTools.length - 1 &&
      !context.isAborted()
    ) {
      if (!await returnToCameraBeforeNextTool(context)) return false;
    }
    if (toolFailed) throw toolError;
    if (index < orderedTools.length - 1 &&
        (tool.name === "View Spotlights" || tool.name === "View Snaps")) {
      if (context.isAborted()) return false;
      if (!await returnToCameraBeforeNextTool(context)) return false;
    }
  }
  return false;
}
