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

export async function attachSnapLink(context: SnapchatContext, rawUrl: string): Promise<boolean> {
  const url = rawUrl.trim();
  if (!url) {
    context.onLog("Upload a Video stopped: Add a link is enabled but its link field is empty.");
    return false;
  }

  let state = await dump(context.serial);
  let linkControl = findLabeledControl(state.nodes, ["link", "add link", "attach link", "link sticker"]);
  if (!linkControl) {
    linkControl = state.nodes.find(node =>
      node.clickable &&
      !/edittext/i.test(node.className) &&
      /(?:^|[/_])(?:link|url)(?:$|[/_])/i.test(`${node.resourceId} ${node.desc}`),
    );
  }
  if (!linkControl) {
    context.onLog("Upload a Video stopped: Snapchat's Snap editor did not expose its Link control.");
    return false;
  }
  if (!await tapNode(context, linkControl, "open the Link control in the video Snap editor")) return false;

  let urlField: UiNode | undefined;
  for (let attempt = 0; attempt < 8; attempt++) {
    state = await dump(context.serial);
    urlField = state.nodes
      .filter(node =>
        /edittext/i.test(node.className) ||
        (/url|link/i.test(node.resourceId) && (node.focusable || node.clickable)),
      )
      .sort((a, b) =>
        (b.bounds[2] - b.bounds[0]) * (b.bounds[3] - b.bounds[1]) -
        (a.bounds[2] - a.bounds[0]) * (a.bounds[3] - a.bounds[1]),
      )[0];
    if (urlField) break;
    if (attempt < 7) await context.sleep(400, "exact");
  }
  if (!urlField) {
    context.onLog("Upload a Video stopped: the Snapchat Link screen did not expose a URL text field.");
    return false;
  }
  if (!await tapNode(context, urlField, "focus the Snapchat link text field", 300)) return false;

  let typed;
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

  const attachLabels = ["attach", "attach link", "attach to snap", "add link", "add to snap", "done"];
  let attachControl: UiNode | undefined;
  for (let attempt = 0; attempt < 8; attempt++) {
    state = await dump(context.serial);
    attachControl = findLabeledControl(state.nodes, attachLabels);
    if (attachControl) break;
    if (attempt < 7) await context.sleep(400, "exact");
  }
  if (!attachControl) {
    context.onLog("Upload a Video stopped: Snapchat did not expose the control to attach the typed link.");
    return false;
  }
  if (!await tapNode(context, attachControl, "attach the typed link to the video Snap", 700)) return false;
  context.onLog("Upload a Video: link attached to the Snap.");
  return true;
}
