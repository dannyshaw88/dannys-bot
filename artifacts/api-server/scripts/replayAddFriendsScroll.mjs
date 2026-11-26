import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const [key, inlineValue] = process.argv[i].split("=", 2);
  if (inlineValue !== undefined) options.set(key, inlineValue);
  else if (process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
    options.set(key, process.argv[++i]);
  } else {
    options.set(key, "true");
  }
}

if (options.has("--help")) {
  console.log(
    "Replay Add Friends scrolling from an Inspect/UIAutomator dump.\n" +
    "Options: --image FILE --xml FILE --crop LEFT,TOP,WIDTH,HEIGHT --screen WIDTH,HEIGHT " +
    "--friend NAME --action add|skip|dismiss --return-screen --align-before-action --regression-fixture " +
    "--previous-center-y PX --row-height PX --divider-fixture",
  );
  process.exit(0);
}

function decodeXml(value = "") {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([\da-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

function parseUiDump(xml) {
  const nodes = [];
  for (const match of xml.matchAll(/<node\b([^>]*)\/?>/g)) {
    const attributes = Object.fromEntries(
      [...match[1].matchAll(/([\w:-]+)="([^"]*)"/g)]
        .map(([, key, value]) => [key, decodeXml(value)]),
    );
    const bounds = attributes.bounds?.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
    if (!bounds) continue;
    nodes.push({
      text: attributes.text ?? "",
      desc: attributes["content-desc"] ?? "",
      resourceId: attributes["resource-id"] ?? "",
      className: attributes.class ?? "",
      packageName: attributes.package ?? "",
      clickable: attributes.clickable === "true",
      focusable: attributes.focusable === "true",
      focused: attributes.focused === "true",
      selected: attributes.selected === "true",
      bounds: bounds.slice(1).map(Number),
    });
  }
  return nodes;
}

function buildFixtureNodes() {
  const nodes = [{
    text: "Find friends", desc: "", resourceId: "com.snapchat.android:id/section-title",
    className: "android.widget.TextView", packageName: "com.snapchat.android",
    clickable: false, focusable: false, focused: false, selected: false, bounds: [20, 240, 700, 280],
  }];
  for (const [index, name] of ["Next contact", "Following contact", "Third contact"].entries()) {
    const top = 300 + index * 120;
    const bottom = top + 120;
    nodes.push({
      text: "", desc: "", resourceId: "com.snapchat.android:id/scu_search_friend_cell",
      className: "android.view.ViewGroup", packageName: "com.snapchat.android",
      clickable: true, focusable: false, focused: false, selected: false, bounds: [16, top, 704, bottom],
    });
    nodes.push({
      text: name, desc: "", resourceId: "com.snapchat.android:id/result-title",
      className: "android.widget.TextView", packageName: "com.snapchat.android",
      clickable: false, focusable: false, focused: false, selected: false, bounds: [32, top + 24, 690, top + 55],
    });
  }
  return nodes;
}

function buildRegressionFixtureNodes() {
  const nodes = [{
    text: "Find friends", desc: "", resourceId: "com.snapchat.android:id/section-title",
    className: "android.widget.TextView", packageName: "com.snapchat.android",
    clickable: false, focusable: false, focused: false, selected: false, bounds: [20, 440, 700, 500],
  }];
  const contacts = [
    ["Ritz Data 1102", 588],
    ["Entourage Donna Pawson", 774],
    ["Noughty Nineties Roxanne Beckett", 960],
    ["lucybrockle", 1146],
    ["Rehab Ed Robotham", 1340],
    ["Lauren Smith", 1526],
    ["Horny Josh Carson", 1712],
  ];
  for (const [name, top] of contacts) {
    nodes.push({
      text: "", desc: "", resourceId: "com.snapchat.android:id/scu_search_friend_cell",
      className: "android.view.ViewGroup", packageName: "com.snapchat.android",
      clickable: true, focusable: false, focused: false, selected: false, bounds: [0, top, 1080, top + 186],
    });
    nodes.push({
      text: name, desc: "", resourceId: "com.snapchat.android:id/result-title",
      className: "android.widget.TextView", packageName: "com.snapchat.android",
      clickable: false, focusable: false, focused: false, selected: false, bounds: [214, top + 30, 644, top + 90],
    });
  }
  return nodes;
}

function rowsFrom(nodes) {
  const titleIndex = nodes.findIndex(node =>
    node.resourceId.split("/").at(-1) === "section-title" &&
    /^find friends$/i.test(node.text || node.desc),
  );
  const endIndex = nodes.findIndex((node, index) =>
    index > titleIndex && node.resourceId.split("/").at(-1) === "section-title",
  );
  return nodes.slice(titleIndex + 1, endIndex < 0 ? nodes.length : endIndex)
    .filter(node =>
      node.resourceId.split("/").at(-1) === "scu_search_friend_cell" &&
      node.bounds[3] > node.bounds[1],
    )
    .sort((a, b) => a.bounds[1] - b.bounds[1]);
}

function nameInRow(nodes, row) {
  return nodes.find(node =>
    node.resourceId.split("/").at(-1) === "result-title" &&
    node.bounds[0] >= row.bounds[0] &&
    node.bounds[1] >= row.bounds[1] &&
    node.bounds[2] <= row.bounds[2] &&
    node.bounds[3] <= row.bounds[3],
  )?.text ?? "";
}

const xmlPath = options.get("--xml");
const regressionFixture = options.has("--regression-fixture");
let nodes = xmlPath
  ? parseUiDump(await fs.readFile(xmlPath, "utf8"))
  : regressionFixture ? buildRegressionFixtureNodes() : buildFixtureNodes();
let rows = rowsFrom(nodes);
assert(rows.length >= 2, "The supplied UI dump must contain at least two Find Friends contact rows.");

let screenWidth;
let screenHeight;
if (options.has("--screen")) {
  [screenWidth, screenHeight] = options.get("--screen").split(",").map(Number);
} else if (!xmlPath) {
  screenWidth = regressionFixture ? 1080 : 720;
  screenHeight = regressionFixture ? 2408 : 1600;
} else {
  screenWidth = Math.max(...nodes.map(node => node.bounds[2]));
  screenHeight = Math.max(...nodes.map(node => node.bounds[3]));
}
assert(screenWidth > 0 && screenHeight > 0, "Could not determine the phone screen dimensions.");

let screenshot;
const imagePath = options.get("--image");
if (imagePath) {
  const sharp = (await import("sharp")).default;
  let image = sharp(imagePath);
  const crop = options.get("--crop");
  if (crop) {
    const [left, top, width, height] = crop.split(",").map(Number);
    image = image.extract({ left, top, width, height });
  } else {
    const metadata = await image.metadata();
    assert(
      metadata.width === screenWidth && metadata.height === screenHeight,
      `Screenshot is ${metadata.width}x${metadata.height}, but the UI dump is ${screenWidth}x${screenHeight}; ` +
      "pass --crop=left,top,width,height for a desktop capture.",
    );
  }
  const decoded = await image.resize(screenWidth, screenHeight).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  screenshot = {
    width: screenWidth,
    height: screenHeight,
    channels: decoded.info.channels,
    pixels: decoded.data,
  };
} else {
  // Default black fixture intentionally has no dividers; --divider-fixture
  // draws neutral divider lines to exercise the pixel-measured path.
  const pixels = Buffer.alloc(screenWidth * screenHeight * 3);
  if (options.has("--divider-fixture")) {
    const rows = rowsFrom(nodes);
    for (const y of new Set(rows.flatMap(row => [row.bounds[1], row.bounds[3]]))) {
      for (let lineY = y; lineY < Math.min(screenHeight, y + 2); lineY++) {
        for (let x = 30; x < Math.min(screenWidth - 20, 692); x++) {
          const index = (lineY * screenWidth + x) * 3;
          pixels[index] = 145;
          pixels[index + 1] = 145;
          pixels[index + 2] = 145;
        }
      }
    }
  }
  screenshot = {
    width: screenWidth,
    height: screenHeight,
    channels: 3,
    pixels,
  };
}

const modulePath = path.join(apiRoot, "node_modules", ".cache", "add-friends-scroll-replay.mjs");
await fs.mkdir(path.dirname(modulePath), { recursive: true });
await build({
  entryPoints: [path.join(apiRoot, "src/mobile/hst/snapchat/navigation/scrollAddFriendsListOneSlot.ts")],
  outfile: modulePath,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  logLevel: "silent",
  plugins: [{
    name: "fake-device-runtime",
    setup(build) {
      build.onResolve({ filter: /^\.\.\/\.\.\/\.\.\/androidManager$/ }, () => ({
        path: "androidManager",
        namespace: "fake-device-runtime",
      }));
      build.onResolve({ filter: /^\.\.\/runtime$/ }, () => ({
        path: "runtime",
        namespace: "fake-device-runtime",
      }));
      build.onLoad({ filter: /.*/, namespace: "fake-device-runtime" }, ({ path: stub }) => ({
        contents: stub === "androidManager"
          ? "export const captureScreenPixels = async () => { throw new Error('Replay must inject screenshot pixels'); }; export const swipe = async () => { throw new Error('Replay must capture gestures'); };"
          : "export const center = node => ({ x: Math.round((node.bounds[0] + node.bounds[2]) / 2), y: Math.round((node.bounds[1] + node.bounds[3]) / 2) }); export const shortResourceId = node => node.resourceId.split('/').pop() ?? node.resourceId; export const dump = async () => { throw new Error('Replay must inject the UI dump'); };",
        loader: "js",
      }));
    },
  }],
});
const { alignAddFriendsContactToTop, alignFirstAddFriendsContactToTop, scrollAddFriendsListOneSlot } =
  await import(pathToFileURL(modulePath).href);
const sceneModelPath = path.join(apiRoot, "node_modules", ".cache", "add-friends-scene-model.mjs");
await build({
  entryPoints: [path.resolve(apiRoot, "../dannys-bot/src/components/tools/addFriendsReplayScene.ts")],
  outfile: sceneModelPath,
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});
const { dismissReplayContact } = await import(pathToFileURL(sceneModelPath).href);

const swipes = [];
const logs = [];
let currentNodes = nodes.map((node, replayId) => ({ ...node, bounds: [...node.bounds], replayId }));
const movementScale = Number(options.get("--movement-scale") ?? (regressionFixture ? 1.5 : 1));
assert(Number.isFinite(movementScale) && movementScale > 0, "--movement-scale must be a positive number.");
const findFriendsHeadingIndex = currentNodes.findIndex(node =>
  node.resourceId.split("/").at(-1) === "section-title" &&
  /^find friends$/i.test(node.text || node.desc),
);
const nextSectionIndex = currentNodes.findIndex((node, index) =>
  index > findFriendsHeadingIndex &&
  node.resourceId.split("/").at(-1) === "section-title",
);
const rowIndicesInTree = currentNodes.flatMap((node, index) =>
  index > findFriendsHeadingIndex &&
  (nextSectionIndex < 0 || index < nextSectionIndex) &&
  node.resourceId.split("/").at(-1) === "scu_search_friend_cell"
    ? [index]
    : [],
);
const rowMemberIds = new Set();
for (let index = 0; index < rowIndicesInTree.length; index++) {
  const start = rowIndicesInTree[index];
  const end = rowIndicesInTree[index + 1] ?? (nextSectionIndex < 0 ? currentNodes.length : nextSectionIndex);
  for (let nodeIndex = start; nodeIndex < end; nodeIndex++) {
    rowMemberIds.add(currentNodes[nodeIndex].replayId);
  }
}
const replayIO = {
  captureScreenPixels: async () => screenshot,
  dump: async () => ({ xml: "", nodes: currentNodes }),
  swipe: async (_serial, x1, y1, x2, y2, durationMs = 300) => {
    swipes.push({ x1, y1, x2, y2, durationMs });
    const speed = Math.abs(y2 - y1) / durationMs;
    const flingMultiplier = options.has("--velocity-sensitive")
      ? 1 + Math.max(0, speed - 0.35) * 2.5
      : 1;
    const contentMovement = Math.round((y2 - y1) * movementScale * flingMultiplier);
    currentNodes = currentNodes.map(node => {
      return rowMemberIds.has(node.replayId)
        ? { ...node, bounds: [node.bounds[0], node.bounds[1] + contentMovement, node.bounds[2], node.bounds[3] + contentMovement] }
        : node;
    });
  },
};

const context = {
  serial: "FAKE_REPLAY_ADD_FRIENDS",
  path: {},
  pickLocalFolderImage: async () => null,
  pickLocalFolderVideo: async () => null,
  tools: {},
  onLog: message => logs.push(message),
  onProgress: () => {},
  isAborted: () => false,
  effectiveTypingProfile: () => ({}),
  sleep: async () => {},
};

const listTop = () => nodes.find(node =>
  node.resourceId.split("/").at(-1) === "section-title" &&
  /^find friends$/i.test(node.text || node.desc),
)?.bounds[3] ?? 0;
const visibleRows = (sourceNodes) => {
  const top = listTop();
  return rowsFrom(sourceNodes).filter(row =>
    row.bounds[1] > Math.max(top, Math.ceil(screenHeight * 0.12)) &&
    row.bounds[3] < Math.floor(screenHeight * 0.82),
  );
};
const requestedFriend = options.get("--friend") ??
  (regressionFixture
    ? "Rehab Ed Robotham"
    : options.has("--align-before-action")
      ? nameInRow(nodes, visibleRows(nodes)[0] ?? rows[0]) || "Previously handled contact"
      : "Previously handled contact");
let alignedBeforeAction = false;
const simulatedAction = options.get("--action")?.toLowerCase();
assert(
  !simulatedAction || ["add", "skip", "dismiss"].includes(simulatedAction),
  "--action must be add, skip, or dismiss.",
);
if (options.has("--align-before-action") || regressionFixture || simulatedAction) {
  alignedBeforeAction = await alignAddFriendsContactToTop(
    context,
    nodes,
    screenWidth,
    screenHeight,
    requestedFriend,
    replayIO,
  );
  assert.equal(alignedBeforeAction, true, `Could not position "${requestedFriend}" at the top before the action.`);
  nodes = currentNodes;
}

rows = rowsFrom(nodes);
const visibleBeforeAction = visibleRows(nodes);
const matchingTarget = rows.find(row => nameInRow(nodes, row) === requestedFriend);
const actionRow = matchingTarget && visibleBeforeAction.includes(matchingTarget)
  ? matchingTarget
  : visibleBeforeAction[0];
assert(actionRow, "The replay has no fully visible contact row after positioning.");
const actionRowIndex = rows.indexOf(actionRow);
const expectedNextName = nameInRow(nodes, rows[actionRowIndex + 1]);
assert(expectedNextName, "The target contact has no following row in the supplied UI dump.");
const expectedTop = actionRow.bounds[1];
const rowBounds = actionRow.bounds;
const priorCenterY = Number(options.get("--previous-center-y") ?? (actionRow.bounds[1] + actionRow.bounds[3]) / 2);
const rowHeight = Number(options.get("--row-height") ?? (actionRow.bounds[3] - actionRow.bounds[1]));
if (simulatedAction === "dismiss") {
  currentNodes = dismissReplayContact(currentNodes, requestedFriend, screenWidth);
  let nextId = Math.max(...currentNodes.map(node => node.replayId ?? -1)) + 1;
  for (const node of currentNodes) {
    if (node.replayId === undefined) {
      node.replayId = nextId++;
      rowMemberIds.add(node.replayId);
    }
  }
  nodes = currentNodes;
} else if (simulatedAction === "add" && options.has("--remove-action-row")) {
  const removedHeight = rowBounds[3] - rowBounds[1];
  currentNodes = currentNodes.flatMap(node => {
    const insideSelectedRow =
      node !== actionRow &&
      node.bounds[0] >= rowBounds[0] &&
      node.bounds[1] >= rowBounds[1] &&
      node.bounds[2] <= rowBounds[2] &&
      node.bounds[3] <= rowBounds[3];
    if (node === actionRow || insideSelectedRow) return [];
    if (rowMemberIds.has(node.replayId) && node.bounds[1] >= rowBounds[3]) {
      return [{
        ...node,
        bounds: [
          node.bounds[0],
          node.bounds[1] - removedHeight,
          node.bounds[2],
          node.bounds[3] - removedHeight,
        ],
      }];
    }
    return [node];
  });
  nodes = currentNodes;
} else if (simulatedAction) {
  currentNodes = currentNodes.flatMap(node => {
    const insideSelectedRow =
      node !== actionRow &&
      node.bounds[0] >= rowBounds[0] &&
      node.bounds[1] >= rowBounds[1] &&
      node.bounds[2] <= rowBounds[2] &&
      node.bounds[3] <= rowBounds[3];
    if (!insideSelectedRow) return [node];
    const resourceId = node.resourceId.split("/").at(-1);
    if (simulatedAction === "add") {
      if (resourceId === "scu_quick_add_chat") return [{ ...node, text: "Message", desc: "Message" }];
      if (resourceId === "scu_search_action_button") return [{ ...node, text: "Snap", desc: "Snap" }];
    }
    return [node];
  });
  nodes = currentNodes;
}
const afterActionNodes = currentNodes.map(({ replayId: _replayId, ...node }) => ({ ...node, bounds: [...node.bounds] }));
const swipesBeforePostAction = swipes.length;
const completed = simulatedAction === "dismiss"
  ? await alignFirstAddFriendsContactToTop(
    context, currentNodes, screenWidth, screenHeight, expectedTop,
    `dismissing ${requestedFriend}`, rowHeight, replayIO,
  )
  : await scrollAddFriendsListOneSlot(
  context,
  nodes,
  screenWidth,
  screenHeight,
  requestedFriend,
  "replay test",
  replayIO,
  expectedNextName,
  expectedTop,
);

if (options.has("--expect-settle-failure")) {
  assert.equal(completed, false, "The helper must refuse to continue after an overshoot.");
} else {
  assert.equal(completed, true, "Scroll helper should complete the fixture replay.");
}
if (!options.has("--remove-action-row")) {
  assert(swipes.length >= 1, "The fake device recorded no scroll gesture.");
}
rows = rowsFrom(currentNodes);
const alignedNext = rows.find(row => nameInRow(currentNodes, row) === expectedNextName);
assert(alignedNext, `The next contact "${expectedNextName}" was not present after the simulated swipe.`);
const alignmentTolerance = Math.max(18, Math.round(screenHeight * 0.012));
if (options.has("--debug")) {
  console.log(JSON.stringify({
    expectedNextName,
    expectedTop,
    actualTop: alignedNext.bounds[1],
    rows: rows.map(row => ({ name: nameInRow(currentNodes, row), bounds: row.bounds })),
    swipes,
    logs,
  }, null, 2));
}
if (!options.has("--expect-settle-failure")) {
  assert(
    Math.abs(alignedNext.bounds[1] - expectedTop) <= alignmentTolerance,
    `Next contact landed at y=${alignedNext.bounds[1]}, expected top y=${expectedTop}.`,
  );
}

console.log(JSON.stringify({
  result: completed ? "PASS" : "UNSETTLED",
  mode: regressionFixture
    ? "logged 4th-add regression fixture with pre-action alignment"
    : imagePath
    ? xmlPath ? "injected screenshot + UI dump" : "injected screenshot + built-in UI fixture"
    : options.has("--divider-fixture")
      ? "built-in pixel-divider fixture"
      : "built-in no-divider fallback fixture",
  dimensions: `${screenWidth}x${screenHeight}`,
  expectedNext: expectedNextName,
  expectedTop,
  actualTop: alignedNext.bounds[1],
  preActionAlignment: alignedBeforeAction,
  simulatedMovementScale: movementScale,
  postActionSwipes: swipes.slice(swipesBeforePostAction),
  ...(options.has("--return-screen")
    ? { nodes: currentNodes.map(({ replayId: _replayId, ...node }) => node), afterActionNodes }
    : {}),
  swipes,
  logs,
}, null, 2));
