import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode } from "../context";
import { center, dump, tapNode } from "../runtime";
import { openUploadSnapCamera } from "../navigation/openUploadSnapCamera";
import { tapUploadSnapMemories } from "../navigation/tapUploadSnapMemories";
import { applySnapImageCrop } from "../navigation/applySnapImageCrop";

export type UploadSnapResult = "not-started" | "completed" | "failed";

function findLabeledControl(nodes: UiNode[], label: string): UiNode | undefined {
  const normalize = (value: string) =>
    value.trim().toLowerCase().replace(/[·•–—-]/g, " ").replace(/\s+/g, " ");
  const normalizedLabel = normalize(label);
  const labelNode = nodes.find(node =>
    normalize(node.text) === normalizedLabel ||
    normalize(node.desc) === normalizedLabel,
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
    if (!await applySnapImageCrop(context)) return "failed";
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

    let publicStory: UiNode | undefined;
    let friendsStory: UiNode | undefined;
    for (let attempt = 0; !publicStory && attempt < 10; attempt++) {
      state = await dump(context.serial);
      publicStory = findLabeledControl(state.nodes, "my story public");
      if (!publicStory) {
        friendsStory = findLabeledControl(state.nodes, "my story friends only") ?? friendsStory;
        if (friendsStory && attempt >= 1) break;
      }
      if (!publicStory && attempt < 9) await context.sleep(500, "exact");
    }
    const selectedAudience = publicStory ? "My Story - Public" : "My Story - Friends Only";
    const audienceControl = publicStory ?? friendsStory;
    if (!audienceControl) {
      context.onLog("Upload a Snap stopped: neither My Story - Public nor My Story - Friends Only was available.");
      return "failed";
    }
    if (!publicStory) context.onLog("Upload a Snap: My Story - Public is unavailable; using My Story - Friends Only.");
    if (!await tapNode(context, audienceControl, `select ${selectedAudience}`)) return "failed";

    state = await dump(context.serial);
    const publicStoryNoticeVisible = Boolean(publicStory) && state.nodes.some(node =>
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
      context.onLog(
        publicStory
          ? "Upload a Snap: no Public Story notice; continuing to the Send chevron."
          : "Upload a Snap: Friends Only selected; continuing to the Send chevron.",
      );
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
      `Snapchat: send ${selectedAudience} with the bottom-right chevron`,
      "automation",
      { exact: true },
    );
    await context.sleep(3_000, "exact");
    context.onLog(`Upload a Snap: tapped Send for "${fileName}" to ${selectedAudience}.`);
    context.onLog("Upload a Snap: allowing Send to settle, then pressing Android Back three times with pauses between presses.");
    for (let press = 1; press <= 3; press++) {
      try {
        await android.keyevent(context.serial, 4);
        context.onLog(`Upload a Snap: Android Back press ${press}/3 sent.`);
      } catch (error) {
        context.onLog(`Upload a Snap: Android Back press ${press}/3 failed: ${error instanceof Error ? error.message : "unknown error"}.`);
      }
      if (press < 3) {
        await context.sleep(2_500, "exact");
      } else {
        await context.sleep(2_000, "exact");
      }
    }
    return "completed";
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
