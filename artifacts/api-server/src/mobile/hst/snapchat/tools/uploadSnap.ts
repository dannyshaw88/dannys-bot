import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode } from "../context";
import { center, dump, tapNode } from "../runtime";
import { openUploadSnapCamera } from "../navigation/openUploadSnapCamera";
import { tapUploadSnapMemories } from "../navigation/tapUploadSnapMemories";

export type UploadSnapResult = "not-started" | "selected" | "failed";

function findLabeledControl(nodes: UiNode[], label: string): UiNode | undefined {
  const normalizedLabel = label.trim().toLowerCase();
  const labelNode = nodes.find(node =>
    node.text.trim().toLowerCase() === normalizedLabel ||
    node.desc.trim().toLowerCase() === normalizedLabel,
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

export async function runUploadSnap(context: SnapchatContext): Promise<UploadSnapResult> {
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
    devicePath = await android.pushFileToDevice(context.serial, localFilePath, fileName, true, true);
    context.onLog(`Upload a Snap: phone gallery copy staged and scanned (${devicePath}).`);
    await context.sleep(1000, "exact");

    let state = await openUploadSnapCamera(context);
    if (!state || !await tapUploadSnapMemories(context, state.nodes)) {
      return "failed";
    }

    state = await dump(context.serial);
    const cameraRollTab = findLabeledControl(state.nodes, "camera roll");
    if (!cameraRollTab || !await tapNode(context, cameraRollTab, "open the Camera Roll tab")) {
      context.onLog("Upload a Snap stopped: the Camera Roll tab was not available in Memories.");
      return "failed";
    }

    state = await dump(context.serial);
    const [screenLeft, screenTop, screenRight, screenBottom] = state.nodes[0].bounds;
    const firstImageX = Math.round(screenLeft + (screenRight - screenLeft) * 0.17);
    const firstImageY = Math.round(screenTop + (screenBottom - screenTop) * 0.46);
    context.onLog(`Upload a Snap: tapping the top-left Camera Roll image at (${firstImageX},${firstImageY}).`);
    await android.tap(
      context.serial,
      firstImageX,
      firstImageY,
      "bot",
      "Snapchat: select the top-left Camera Roll image",
      "automation",
      { exact: true },
    );
    await context.sleep(700, "exact");
    state = await dump(context.serial);

    let sendToButton = findLabeledControl(state.nodes, "send to");
    for (let attempt = 0; !sendToButton && attempt < 10; attempt++) {
      if (attempt > 0) await context.sleep(500, "exact");
      state = await dump(context.serial);
      sendToButton = findLabeledControl(state.nodes, "send to");
    }
    if (!sendToButton || !await tapNode(context, sendToButton, "open Send To from the Snap editor")) {
      context.onLog("Upload a Snap stopped: the Send To button was not available in the Snap editor.");
      return "failed";
    }

    let publicStory = findLabeledControl(state.nodes, "my story · public");
    for (let attempt = 0; !publicStory && attempt < 10; attempt++) {
      if (attempt > 0) await context.sleep(500, "exact");
      state = await dump(context.serial);
      publicStory = findLabeledControl(state.nodes, "my story · public");
    }
    if (!publicStory || !await tapNode(context, publicStory, "select My Story - Public")) {
      context.onLog("Upload a Snap stopped: My Story - Public was not available in Snapchat's Send To list.");
      return "failed";
    }

    state = await dump(context.serial);
    const publicStoryNoticeVisible = state.nodes.some(node =>
      node.text.trim().toLowerCase() === "introducing your public story" ||
      node.desc.trim().toLowerCase() === "introducing your public story",
    );
    if (publicStoryNoticeVisible) {
      const { w: screenWidth, h: screenHeight } = await android.getScreenSizeAsync(context.serial);
      const okayX = Math.round(screenWidth * 0.5);
      const okayY = Math.round(screenHeight * 0.82);
      context.onLog(`Upload a Snap: Public Story notice is visible; tapping Okay at (${okayX},${okayY}).`);
      await android.tap(
        context.serial,
        okayX,
        okayY,
        "bot",
        "Snapchat: dismiss Introducing Your Public Story with Okay",
        "automation",
        { exact: true },
      );
      await context.sleep(800, "exact");
      context.onLog("Upload a Snap: tapped Okay on the Public Story notice.");
    } else {
      context.onLog("Upload a Snap: no Public Story notice; continuing to the Send chevron.");
    }

    const { w: screenWidth, h: screenHeight } = await android.getScreenSizeAsync(context.serial);
    const sendX = Math.round(screenWidth * 0.92);
    const sendY = Math.round(screenHeight * 0.9);
    context.onLog(`Upload a Snap: tapping the Send chevron at (${sendX},${sendY}) on ${screenWidth}×${screenHeight}.`);
    await android.tap(
      context.serial,
      sendX,
      sendY,
      "bot",
      "Snapchat: send My Story - Public with the bottom-right chevron",
      "automation",
      { exact: true },
    );
    await context.sleep(1200, "exact");
    context.onLog(`Upload a Snap: tapped Send for "${fileName}" to My Story - Public.`);
    context.onLog("Upload a Snap: pressing Android Back twice after Send.");
    for (let press = 1; press <= 2; press++) {
      try {
        await android.keyevent(context.serial, 4);
        context.onLog(`Upload a Snap: Android Back press ${press}/2 sent.`);
      } catch (error) {
        context.onLog(`Upload a Snap: Android Back press ${press}/2 failed: ${error instanceof Error ? error.message : "unknown error"}.`);
      }
      if (press < 2) await context.sleep(500, "exact");
    }
    return "selected";
  } catch (error) {
    context.onLog(`Upload a Snap stopped: ${error instanceof Error ? error.message : "image staging or navigation failed"}.`);
    return "failed";
  } finally {
    if (devicePath) {
      try {
        await android.removeDeviceFileStrict(context.serial, devicePath);
        context.onLog("Upload a Snap: deleted the staged image from the phone; the local PC source was kept.");
      } catch (error) {
        context.onLog(`Upload a Snap: failed to delete the staged phone image: ${error instanceof Error ? error.message : "unknown error"}.`);
      }
    }
  }
}
