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

function captionCanvasPoint(
  nodes: UiNode[],
  screenWidth: number,
  screenHeight: number,
): { x: number; y: number } | undefined {
  // The link sticker occupies the middle of the Snap. Enter caption mode by
  // tapping open canvas above it; if that area is covered, use open canvas
  // below it. Never target the top toolbar, close button, or link itself.
  const candidates = [
    { x: 0.5, y: 0.35, area: "above the link sticker" },
    { x: 0.5, y: 0.62, area: "below the link sticker" },
  ];

  for (const candidate of candidates) {
    const x = Math.round(screenWidth * candidate.x);
    const y = Math.round(screenHeight * candidate.y);
    const blocked = nodes.some(node => {
      const [left, top, right, bottom] = node.bounds;
      if (x < left || x > right || y < top || y > bottom) return false;
      const label = `${node.text} ${node.desc} ${node.resourceId}`;
      const nodeArea = Math.max(0, right - left) * Math.max(0, bottom - top);
      const isLink = /boundlus|https?:\/\/|link sticker|attach to snap/i.test(label);
      const isSmallAction = node.clickable && nodeArea < screenWidth * screenHeight * 0.18;
      return isLink || isSmallAction;
    });
    if (!blocked) return { x, y };
  }
  return undefined;
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
  if (await android.isKeyboardShown(context.serial).catch(() => false)) {
    if (linkWasJustAttached) {
      context.onLog("Upload a Video stopped: the keyboard is still open after Attach to Snap; refusing Android Back because it could leave the Snap editor.");
      return false;
    }
    await android.keyevent(context.serial, 4);
    await context.sleep(350, "exact");
    state = await dump(context.serial);
    if (!findSendTo(state.nodes)) {
      context.onLog("Upload a Video stopped: could not dismiss the existing keyboard while returning to the Snap editor.");
      return false;
    }
  }

  const { w: screenWidth, h: screenHeight } = await android.getScreenSizeAsync(context.serial);
  const captionPoint = captionCanvasPoint(state.nodes, screenWidth, screenHeight);
  if (!captionPoint) {
    context.onLog("Upload a Video stopped: no safe open canvas point was found above or below the link sticker to start the caption.");
    return false;
  }
  context.onLog(`Upload a Video: tapping open Snap canvas ${captionPoint.y < screenHeight * 0.5 ? "above" : "below"} the link sticker at (${captionPoint.x},${captionPoint.y}) on ${screenWidth}×${screenHeight} to start the caption.`);
  await android.tap(
    context.serial,
    captionPoint.x,
    captionPoint.y,
    "bot",
    "Snapchat: tap open video canvas to start caption entry",
    "automation",
    { exact: true },
  );
  await context.sleep(700, "exact");

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
  for (let attempt = 0; attempt < 8; attempt++) {
    state = await dump(context.serial);
    const sendToVisible = Boolean(findSendTo(state.nodes));
    const keyboardVisibleAfterCommit = await android.isKeyboardShown(context.serial).catch(() => true);
    if (sendToVisible && !keyboardVisibleAfterCommit) {
      context.onLog("Upload a Video: caption committed; Snapchat returned to the Snap editor and Send To is available.");
      return true;
    }
    if (attempt < 7) await context.sleep(350, "exact");
  }

  context.onLog("Upload a Video stopped: Snapchat did not close the caption keyboard and return to the video Snap editor after the Enter/tick tap.");
  return false;
}
