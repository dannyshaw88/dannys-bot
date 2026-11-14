import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode } from "../context";
import { center, dump, tapNode } from "../runtime";

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[·•–—-]/g, " ").replace(/\s+/g, " ");
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

function getUrlFieldValue(node: UiNode): string {
  return [node.text, node.desc]
    .map(value => value.trim())
    .find(value => value && !/^type (?:a )?url$/i.test(value)) ?? "";
}

function findAttachButton(nodes: UiNode[]): UiNode | undefined {
  return nodes.find(node =>
    node.resourceId.split("/").pop() === "attachment-editor-attach-button",
  ) ?? findLabeledControl(nodes, ["attach to snap"]);
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
  await context.sleep(1_000, "exact");

  let clipboardPromptVisible = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    state = await dump(context.serial);
    clipboardPromptVisible = hasClipboardAccessPrompt(state.nodes);
    if (clipboardPromptVisible || findUrlField(state.nodes)) break;
    if (attempt < 7) await context.sleep(400, "exact");
  }

  if (clipboardPromptVisible) {
    const notNowButton = findLabeledControl(state.nodes, ["not now"]);
    if (!notNowButton) {
      context.onLog("Upload a Video stopped: Snapchat's clipboard prompt appeared without a visible Not now button.");
      return false;
    }
    context.onLog("Upload a Video: dismissing Snapchat's clipboard prompt with Not now.");
    if (!await tapNode(context, notNowButton, "dismiss Snapchat's clipboard prompt with Not now", 500, true)) return false;

    for (let attempt = 0; attempt < 6; attempt++) {
      state = await dump(context.serial);
      clipboardPromptVisible = hasClipboardAccessPrompt(state.nodes);
      if (!clipboardPromptVisible) break;
      if (attempt < 5) await context.sleep(300, "exact");
    }
    if (clipboardPromptVisible) {
      context.onLog("Upload a Video stopped: Snapchat's clipboard prompt remained open after tapping Not now.");
      return false;
    }
  }

  let urlField: UiNode | undefined;
  for (let attempt = 0; attempt < 8; attempt++) {
    state = await dump(context.serial);
    urlField = findUrlField(state.nodes);
    if (urlField) break;
    if (attempt < 7) await context.sleep(400, "exact");
  }
  if (!urlField) {
    context.onLog("Upload a Video stopped: the Snapchat Link screen did not expose a URL text field.");
    return false;
  }
  if (!await tapNode(context, urlField, "focus the Snapchat link text field", 300)) return false;

  // Snapchat's empty URL field reports its hint ("Type a URL") as both text
  // and content description in some builds. Do not mistake that placeholder
  // for a pre-existing URL or the flow will stop before calibrated typing.
  const previousText = getUrlFieldValue(urlField);
  if (previousText) {
    try {
      await android.clearFocusedTextField(
        context.serial,
        message => context.onLog(`Upload a Video: ${message}`),
      );
    } catch (error) {
      context.onLog(`Upload a Video stopped: could not clear the existing Snapchat link text${error instanceof Error ? ` (${error.message})` : ""}.`);
      return false;
    }
    state = await dump(context.serial);
    urlField = findUrlField(state.nodes);
    if (!urlField || getUrlFieldValue(urlField)) {
      context.onLog("Upload a Video stopped: the existing link text could not be cleared and verified.");
      return false;
    }
  }

  let typed;
  context.onLog("Upload a Video: starting URL entry with this device's saved keyboard calibration.");
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

  context.onLog("Upload a Video: pressing the device's calibrated Enter/Search keyboard key to load the link preview.");
  if (!await android.tapCalibratedKeyboardKey(
    context.serial,
    "enter",
    message => context.onLog(`Upload a Video: ${message}`),
  )) {
    context.onLog("Upload a Video stopped: the calibrated keyboard Enter/Search key could not be tapped.");
    return false;
  }

  let attachControl: UiNode | undefined;
  for (let attempt = 0; attempt < 24; attempt++) {
    state = await dump(context.serial);
    attachControl = findAttachButton(state.nodes);
    if (attachControl) break;
    if (attempt < 23) await context.sleep(500, "exact");
  }
  if (!attachControl) {
    context.onLog("Upload a Video stopped: Snapchat did not show the link preview or its Attach to Snap button after the URL search.");
    return false;
  }
  if (!await tapNode(context, attachControl, "tap the blue Attach to Snap button after the URL preview loads", 700)) return false;
  context.onLog("Upload a Video: link attached to the Snap.");
  return true;
}
