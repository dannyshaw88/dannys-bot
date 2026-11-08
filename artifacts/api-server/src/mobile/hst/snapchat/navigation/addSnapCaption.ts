import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode } from "../context";
import { center, dump, tapNode } from "../runtime";

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function findSendTo(nodes: UiNode[]): UiNode | undefined {
  const label = nodes.find(node =>
    normalize(node.text) === "send to" || normalize(node.desc) === "send to",
  );
  if (!label || label.clickable) return label;
  const point = center(label);
  return nodes
    .filter(node => {
      const [left, top, right, bottom] = node.bounds;
      return node.clickable &&
        point.x >= left && point.x <= right &&
        point.y >= top && point.y <= bottom;
    })
    .sort((a, b) =>
      (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) -
      (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]),
    )[0] ?? label;
}

function findTextTool(nodes: UiNode[], screenWidth: number, screenHeight: number): UiNode | undefined {
  const textTool = nodes.find(node => {
    const point = center(node);
    const label = normalize(`${node.text} ${node.desc}`);
    const resource = node.resourceId.split("/").pop() ?? node.resourceId;
    return point.x >= screenWidth * 0.78 &&
      point.y >= screenHeight * 0.025 &&
      point.y <= screenHeight * 0.13 &&
      (/^(?:t|text|add text|caption)$/.test(label) ||
        /(?:text|caption).*tool|tool.*(?:text|caption)/i.test(resource));
  });
  if (!textTool || textTool.clickable) return textTool;
  const point = center(textTool);
  return nodes
    .filter(node => {
      const [left, top, right, bottom] = node.bounds;
      return node.clickable &&
        point.x >= left && point.x <= right &&
        point.y >= top && point.y <= bottom;
    })
    .sort((a, b) =>
      (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]) -
      (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]),
    )[0] ?? textTool;
}

export async function addSnapCaption(
  context: SnapchatContext,
  rawCaption: string,
  linkWasJustAttached = false,
): Promise<boolean> {
  const caption = rawCaption.trim();
  if (!caption) {
    context.onLog("Upload a Video: caption is blank; skipping the Snapchat text tool.");
    return true;
  }

  let state = await dump(context.serial);
  const sendToVisible = Boolean(findSendTo(state.nodes));
  if (!sendToVisible && !linkWasJustAttached) {
    context.onLog("Upload a Video stopped: the video Snap editor was not visible before adding its caption.");
    return false;
  }
  if (!sendToVisible && linkWasJustAttached) {
    context.onLog("Upload a Video: Send To is not exposed in the accessibility tree after Attach to Snap; continuing from the confirmed link-attach transition to open the text tool.");
  }

  // Tapping the text toolbar button opens Snapchat's caption editor and
  // keyboard. The current Snapchat UI exposes no reliable label for this
  // icon, so use its observed top-right location only on the confirmed editor.
  if (!linkWasJustAttached && await android.isKeyboardShown(context.serial).catch(() => false)) {
    await android.keyevent(context.serial, 4);
    await context.sleep(350, "exact");
    state = await dump(context.serial);
    if (!findSendTo(state.nodes)) {
      context.onLog("Upload a Video stopped: could not dismiss the existing keyboard while returning to the Snap editor.");
      return false;
    }
  }
  if (linkWasJustAttached) {
    context.onLog("Upload a Video: link attachment was confirmed; proceeding directly to the top-right T icon without an Android Back or keyboard precheck.");
  }

  const { w: screenWidth, h: screenHeight } = await android.getScreenSizeAsync(context.serial);
  const textTool = findTextTool(state.nodes, screenWidth, screenHeight);
  if (textTool) {
    const point = center(textTool);
    context.onLog(`Upload a Video: tapping the detected T caption icon at (${point.x},${point.y}) on ${screenWidth}×${screenHeight}.`);
    if (!await tapNode(context, textTool, "open the Snapchat caption editor with the top-right T icon", 700, true)) return false;
  } else {
    // On some Snapchat builds the T icon has no accessibility label. Its
    // known location is at the top-right of the confirmed Snap editor.
    const textToolX = Math.round(screenWidth * 0.93);
    const textToolY = Math.round(screenHeight * 0.065);
    context.onLog(`Upload a Video: tapping the top-right T caption icon at (${textToolX},${textToolY}) on ${screenWidth}×${screenHeight}.`);
    await android.tap(
      context.serial,
      textToolX,
      textToolY,
      "bot",
      "Snapchat: tap the top-right T icon to start caption entry",
      "automation",
      { exact: true },
    );
    await context.sleep(700, "exact");
  }

  let keyboardVisible = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (await android.isKeyboardShown(context.serial).catch(() => false)) {
      keyboardVisible = true;
      break;
    }
    if (attempt < 7) await context.sleep(300, "exact");
  }
  if (!keyboardVisible) {
    context.onLog("Upload a Video stopped: Snapchat's caption keyboard did not open after tapping the T text tool.");
    return false;
  }

  let typed;
  try {
    typed = await android.typeViaSavedCalibrationMap(
      context.serial,
      caption,
      context.effectiveTypingProfile(context.serial),
      message => context.onLog(`Upload a Video: ${message}`),
      {
        debugLabel: "Snapchat video caption",
        disableHumanErrors: true,
        compactLogs: true,
        onProgress: context.onProgress,
        batchTaps: true,
      },
    );
  } catch (error) {
    context.onLog(`Upload a Video stopped: calibrated caption typing failed${error instanceof Error ? ` (${error.message})` : ""}.`);
    return false;
  }
  if (!typed.available || !typed.ok || typed.fatal || typed.missing.length > 0) {
    const detail = typed.missing.length ? `; missing calibrated key(s): ${[...new Set(typed.missing)].join(", ")}` : "";
    context.onLog(`Upload a Video stopped: the caption could not be fully typed with this device's key calibration${detail}.`);
    return false;
  }
  context.onLog(`Upload a Video: caption entered using the saved keyboard calibration (${caption.length} characters).`);

  // Snapchat commits the caption with the keyboard's bottom-right tick/Enter
  // action. Back only hides the keyboard and does not finish caption editing.
  context.onLog("Upload a Video: committing the caption with the device's calibrated keyboard Enter/tick key.");
  if (!await android.tapCalibratedKeyboardKey(
    context.serial,
    "enter",
    message => context.onLog(`Upload a Video: ${message}`),
  )) {
    context.onLog("Upload a Video stopped: the calibrated keyboard Enter/tick key could not be tapped to commit the caption.");
    return false;
  }
  await context.sleep(500, "exact");
  context.onLog("Upload a Video: caption Enter/tick sent; proceeding to Send To.");
  return true;
}
