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
    "Replay Add Friends scrolling with an injected screenshot and UIAutomator XML.\n" +
    "Options: --image FILE --xml FILE --crop LEFT,TOP,WIDTH,HEIGHT --screen WIDTH,HEIGHT " +
    "--friend NAME --previous-center-y PX --row-height PX",
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
    const bounds = attributes.bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
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
let nodes = xmlPath ? parseUiDump(await fs.readFile(xmlPath, "utf8")) : buildFixtureNodes();
let rows = rowsFrom(nodes);
assert(rows.length >= 2, "The supplied UI dump must contain at least two Find Friends contact rows.");

let screenWidth;
let screenHeight;
if (options.has("--screen")) {
  [screenWidth, screenHeight] = options.get("--screen").split(",").map(Number);
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
  // A black fixture intentionally has no detectable divider lines. This exercises
  // the live per-row-height fallback while the injected device records the swipe.
  screenshot = {
    width: screenWidth,
    height: screenHeight,
    channels: 3,
    pixels: Buffer.alloc(screenWidth * screenHeight * 3),
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
});
const { scrollAddFriendsListOneSlot } = await import(pathToFileURL(modulePath).href);

const swipes = [];
const logs = [];
let currentNodes = nodes.map(node => ({ ...node, bounds: [...node.bounds] }));
const replayIO = {
  captureScreenPixels: async () => screenshot,
  dump: async () => ({ xml: "", nodes: currentNodes }),
  swipe: async (_serial, x1, y1, x2, y2, durationMs = 300) => {
    swipes.push({ x1, y1, x2, y2, durationMs });
    const contentMovement = y2 - y1;
    const currentRows = rowsFrom(currentNodes);
    currentNodes = currentNodes.map(node => {
      const belongsToRow = currentRows.some(row =>
        row === node ||
        (node.bounds[0] >= row.bounds[0] &&
         node.bounds[1] >= row.bounds[1] &&
         node.bounds[2] <= row.bounds[2] &&
         node.bounds[3] <= row.bounds[3]),
      );
      return belongsToRow
        ? { ...node, bounds: [node.bounds[0], node.bounds[1] + contentMovement, node.bounds[2], node.bounds[3] + contentMovement] }
        : node;
    });
  },
};

const priorCenterY = Number(options.get("--previous-center-y") ?? (rows[0].bounds[1] + rows[0].bounds[3]) / 2);
const rowHeight = Number(options.get("--row-height") ?? (rows[0].bounds[3] - rows[0].bounds[1]));
const expectedTop = rows[0].bounds[1];
const expectedNextName = nameInRow(nodes, rows[1]);
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

const completed = await scrollAddFriendsListOneSlot(
  context,
  nodes,
  screenWidth,
  screenHeight,
  options.get("--friend") ?? "Previously handled contact",
  "replay test",
  priorCenterY,
  rowHeight,
  replayIO,
);

assert.equal(completed, true, "Scroll helper should complete the fixture replay.");
assert(swipes.length >= 1, "The fake device recorded no scroll gesture.");
rows = rowsFrom(currentNodes);
const alignedNext = rows.find(row => nameInRow(currentNodes, row) === expectedNextName);
assert(alignedNext, `The next contact "${expectedNextName}" was not present after the simulated swipe.`);
const alignmentTolerance = Math.max(18, Math.round(screenHeight * 0.012));
assert(
  Math.abs(alignedNext.bounds[1] - expectedTop) <= alignmentTolerance,
  `Next contact landed at y=${alignedNext.bounds[1]}, expected top y=${expectedTop}.`,
);

console.log(JSON.stringify({
  result: "PASS",
  mode: imagePath ? "injected screenshot + UI dump" : "built-in no-divider fallback fixture",
  dimensions: `${screenWidth}x${screenHeight}`,
  expectedNext: expectedNextName,
  expectedTop,
  actualTop: alignedNext.bounds[1],
  swipes,
  logs,
}, null, 2));
