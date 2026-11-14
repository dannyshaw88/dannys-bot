import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode } from "../context";
import { center, dump, shortResourceId, tapNode } from "../runtime";

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[·•–—-]/g, " ").replace(/\s+/g, " ");
}

function findEditorMoreChevron(nodes: UiNode[]): UiNode | undefined {
  const root = nodes[0];
  if (!root) return undefined;
  const [rootLeft, rootTop, rootRight, rootBottom] = root.bounds;
  const screenWidth = rootRight - rootLeft;
  const screenHeight = rootBottom - rootTop;
  if (screenWidth <= 0 || screenHeight <= 0) return undefined;

  const isRightToolbarNode = (node: UiNode) => {
    const [left, top, right, bottom] = node.bounds;
    const point = center(node);
    return point.x >= rootLeft + screenWidth * 0.68 &&
      point.y >= rootTop + screenHeight * 0.06 &&
      point.y <= rootTop + screenHeight * 0.86 &&
      right - left <= screenWidth * 0.2 &&
      bottom - top <= screenHeight * 0.12;
  };
  const labels = new Set(["more", "more tools", "show more tools", "expand tools"]);
  const labelNode = nodes.find(node =>
    isRightToolbarNode(node) &&
    (shortResourceId(node) === "more" ||
      labels.has(normalize(node.text)) ||
      labels.has(normalize(node.desc))),
  );
  if (!labelNode || labelNode.clickable) return labelNode;

  const point = center(labelNode);
  return nodes
    .filter(node => {
      const [left, top, right, bottom] = node.bounds;
      return node.clickable &&
        isRightToolbarNode(node) &&
        point.x >= left &&
        point.x <= right &&
        point.y >= top &&
        point.y <= bottom;
    })
    .sort((a, b) =>
      (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) -
      (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]),
    )[0] ?? labelNode;
}

function findLabeledControl(nodes: UiNode[], labels: string[]): UiNode | undefined {
  const normalizedLabels = new Set(labels.map(normalize));
  const labelNode = nodes.find(node =>
    normalizedLabels.has(normalize(node.text)) ||
    normalizedLabels.has(normalize(node.desc)),
  );
  if (!labelNode || labelNode.clickable) return labelNode;

  const point = center(labelNode);
  return nodes
    .filter(node => {
      const [left, top, right, bottom] = node.bounds;
      return node.clickable &&
        point.x >= left &&
        point.x <= right &&
        point.y >= top &&
        point.y <= bottom;
    })
    .sort((a, b) =>
      (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) -
      (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]),
    )[0] ?? labelNode;
}

function findUrlField(nodes: UiNode[]): UiNode | undefined {
  return nodes.find(node =>
    node.resourceId.split("/").pop() === "attachment-editor-text-field",
  ) ?? nodes
    .filter(node =>
      /edittext/i.test(node.className) ||
      (/url|link/i.test(node.resourceId) && (node.focusable || node.clickable)),
    )
    .sort((a, b) =>
      (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]) -
      (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]),
    )[0];
}

function hasClipboardAccessPrompt(nodes: UiNode[]): boolean {
  const hasTitle = nodes.some(node =>
    /show links i['’]ve recently copied\?/i.test(`${node.text} ${node.desc}`),
  );
  const hasExplanation = nodes.some(node =>
    /requires clipboard access for snapchat/i.test(`${node.text} ${node.desc}`),
  );
  return hasTitle && hasExplanation;
}

export async function attachSnapLink(context: SnapchatContext, rawUrl: string): Promise<boolean> {
  const url = rawUrl.trim();
  if (!url) {
    context.onLog("Upload a Video stopped: Add a link is enabled but its link field is empty.");
    return false;
  }

  let state = await dump(context.serial);
  const sendToVisible = Boolean(findLabeledControl(state.nodes, ["send to"]));
  if (!sendToVisible) {
    context.onLog("Upload a Video stopped: the video Snap editor was not visible before opening the paperclip.");
    return false;
  }

  const moreChevron = findEditorMoreChevron(state.nodes);
  if (!moreChevron) {
    context.onLog("Upload a Video stopped: Snapchat's right-side downward More chevron was not exposed as a live UI node.");
    return false;
  }
  const morePoint = center(moreChevron);
  context.onLog(`Upload a Video: tapping the live downward More chevron at (${morePoint.x},${morePoint.y}) to expose the Paperclip.`);
  if (!await tapNode(context, moreChevron, "expand the video editor toolbar with its downward More chevron", 2_500, true)) return false;

  context.onLog("Upload a Video: tapping this device's calibrated Click Paperclip point.");
  try {
    const point = await android.tapCalibratedNavigationControl(
      context.serial,
      "snapchatClickPaperclip",
      message => context.onLog(`Upload a Video: ${message}`),
      "Snapchat: tap the calibrated Paperclip control in the video editor",
    );
    context.onLog(`Upload a Video: calibrated Paperclip tap sent at (${point.x},${point.y}).`);
  } catch (error) {
    context.onLog(
      `Upload a Video stopped: Click Paperclip is not calibrated for this device${error instanceof Error ? ` (${error.message})` : ""}.`,
    );
    return false;
  }
  await context.sleep(500, "exact");
  state = await dump(context.serial);
  let notNowButton = findLabeledControl(state.nodes, ["not now"]);
  if (hasClipboardAccessPrompt(state.nodes) || notNowButton) {
    if (!notNowButton) {
      context.onLog("Upload a Video stopped: Snapchat's clipboard prompt appeared without a visible Not now button.");
      return false;
    }
    context.onLog("Upload a Video: dismissing Snapchat's clipboard prompt with Not now.");
    if (!await tapNode(context, notNowButton, "dismiss Snapchat's clipboard prompt with Not now", 350, true)) return false;
    state = await dump(context.serial);
  }

  let urlField = findUrlField(state.nodes);
  if (!urlField) {
    await context.sleep(350, "exact");
    state = await dump(context.serial);
    urlField = findUrlField(state.nodes);
  }
  if (!urlField) {
    context.onLog("Upload a Video stopped: the Snapchat Link screen did not expose a URL text field.");
    return false;
  }

  if (!urlField.focused) {
    if (!await tapNode(context, urlField, "focus the Snapchat link text field", 200)) return false;
    state = await dump(context.serial);
    notNowButton = findLabeledControl(state.nodes, ["not now"]);
    if (hasClipboardAccessPrompt(state.nodes) || notNowButton) {
      if (!notNowButton) {
        context.onLog("Upload a Video stopped: Snapchat's clipboard prompt appeared after focusing the URL field without a visible Not now button.");
        return false;
      }
      context.onLog("Upload a Video: dismissing the clipboard prompt after focusing the URL field.");
      if (!await tapNode(context, notNowButton, "dismiss Snapchat's clipboard prompt with Not now", 350, true)) return false;
    }
  }

  let typed;
  context.onLog("Upload a Video: typing the configured URL directly with this device's saved keyboard calibration.");
  try {
    typed = await android.typeViaSavedCalibrationMap(
      context.serial,
      url,
      context.effectiveTypingProfile(context.serial),
      message => context.onLog(`Upload a Video: ${message}`),
      {
        debugLabel: "Snapchat video link",
        disableHumanErrors: true,
        compactLogs: true,
        onProgress: context.onProgress,
        batchTaps: true,
      },
    );
  } catch (error) {
    context.onLog(
      `Upload a Video stopped: calibrated link typing failed${error instanceof Error ? ` (${error.message})` : ""}.`,
    );
    return false;
  }
  if (!typed.available || !typed.ok || typed.fatal || typed.missing.length > 0) {
    const detail = typed.missing.length ? `; missing calibrated key(s): ${[...new Set(typed.missing)].join(", ")}` : "";
    context.onLog(`Upload a Video stopped: the link could not be fully typed with this device's key calibration${detail}.`);
    return false;
  }
  context.onLog("Upload a Video: link text entered using the device's saved keyboard calibration.");

  context.onLog("Upload a Video: pressing the saved Enter/Search calibration directly to load the link preview.");
  if (!await android.tapCalibratedKeyboardKey(
    context.serial,
    "enter",
    message => context.onLog(`Upload a Video: ${message}`),
    { directSavedCalibration: true },
  )) {
    context.onLog("Upload a Video stopped: the calibrated keyboard Enter/Search key could not be tapped.");
    return false;
  }

  await context.sleep(3_000, "exact");
  const screenRoot = state.nodes[0];
  if (!screenRoot) {
    context.onLog("Upload a Video stopped: the link editor tree did not provide screen bounds for the Attach to Snap button.");
    return false;
  }
  const [screenLeft, screenTop, screenRight, screenBottom] = screenRoot.bounds;
  const screenWidth = screenRight - screenLeft;
  const screenHeight = screenBottom - screenTop;
  if (screenWidth <= 0 || screenHeight <= 0) {
    context.onLog("Upload a Video stopped: the link editor tree provided invalid screen bounds for Attach to Snap.");
    return false;
  }
  const attachX = Math.round(screenLeft + screenWidth * 0.5);
  const attachY = Math.round(screenTop + screenHeight * 0.904);
  context.onLog(
    `Upload a Video: the live tree does not expose Snapchat's web-preview Attach to Snap button; ` +
    `tapping its fixed bottom-center position at (${attachX},${attachY}).`,
  );
  await android.tap(
    context.serial,
    attachX,
    attachY,
    "bot",
    "Snapchat: attach the loaded link preview to the video Snap",
    "automation",
    { exact: true },
  );
  await context.sleep(700, "exact");
  context.onLog("Upload a Video: Attach to Snap tap sent; continuing with the Snap editor flow.");
  return true;
}
