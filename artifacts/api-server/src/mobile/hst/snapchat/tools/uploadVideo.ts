import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode } from "../context";
import { center, dump, randomCount, tapNode } from "../runtime";
import { openUploadSnapCamera } from "../navigation/openUploadSnapCamera";
import { tapUploadSnapMemories } from "../navigation/tapUploadSnapMemories";
import { attachSnapLink } from "../navigation/attachSnapLink";
import { addSnapCaption } from "../navigation/addSnapCaption";

export type UploadVideoResult = "not-started" | "completed" | "failed";

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

async function uploadOneVideo(context: SnapchatContext, fileName: string): Promise<UploadVideoResult> {
  const settings = context.tools.uploadVideo;
  const localFilePath = context.path.join(settings.directoryPath, fileName);
  let devicePath = "";
  try {
    context.onLog(`Upload a Video: staging "${fileName}" in the phone gallery.`);
    devicePath = await android.pushFileToDevice(context.serial, localFilePath, fileName, true, true);
    context.onLog(`Upload a Video: video staged and scanned (${devicePath}).`);
    await context.sleep(1000, "exact");

    let state = await openUploadSnapCamera(context);
    if (!state || !await tapUploadSnapMemories(context, state.nodes)) return "failed";

    state = await dump(context.serial);
    const cameraRollTab = findLabeledControl(state.nodes, "camera roll");
    if (!cameraRollTab || !await tapNode(context, cameraRollTab, "open the Camera Roll tab")) {
      context.onLog("Upload a Video stopped: the Camera Roll tab was not available in Memories.");
      return "failed";
    }

    state = await dump(context.serial);
    const screen = state.nodes[0];
    if (!screen) {
      context.onLog("Upload a Video stopped: the Camera Roll screen had no usable bounds.");
      return "failed";
    }
    const [screenLeft, screenTop, screenRight, screenBottom] = screen.bounds;
    const firstVideoX = Math.round(screenLeft + (screenRight - screenLeft) * 0.17);
    const firstVideoY = Math.round(screenTop + (screenBottom - screenTop) * 0.46);
    context.onLog(`Upload a Video: selecting the staged video at (${firstVideoX},${firstVideoY}).`);
    await android.tap(
      context.serial,
      firstVideoX,
      firstVideoY,
      "bot",
      "Snapchat: select the top-left Camera Roll video",
      "automation",
      { exact: true },
    );
    await context.sleep(700, "exact");

    if (settings.addLink || settings.caption.trim()) {
      let editorReady = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        state = await dump(context.serial);
        if (findLabeledControl(state.nodes, "send to")) {
          editorReady = true;
          break;
        }
        if (attempt < 11) await context.sleep(500, "exact");
      }
      if (!editorReady) {
        context.onLog("Upload a Video stopped: Snapchat did not finish opening the video Snap editor after selecting the video.");
        return "failed";
      }
      if (settings.addLink && !await attachSnapLink(context, settings.linkUrl)) return "failed";
      if (!await addSnapCaption(context, settings.caption)) return "failed";
    }

    state = await dump(context.serial);
    let sendToButton = findLabeledControl(state.nodes, "send to");
    for (let attempt = 0; !sendToButton && attempt < 10; attempt++) {
      if (attempt > 0) await context.sleep(500, "exact");
      state = await dump(context.serial);
      sendToButton = findLabeledControl(state.nodes, "send to");
    }
    if (!sendToButton || !await tapNode(context, sendToButton, "open Send To from the video Snap editor")) {
      context.onLog("Upload a Video stopped: the Send To button was not available in the video editor.");
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
      context.onLog("Upload a Video stopped: neither My Story - Public nor My Story - Friends Only was available.");
      return "failed";
    }
    if (!publicStory) context.onLog("Upload a Video: My Story - Public is unavailable; using My Story - Friends Only.");
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
      context.onLog(`Upload a Video: Public Story notice is visible; tapping Okay at (${okayX},${okayY}).`);
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
    }

    const { w: screenWidth, h: screenHeight } = await android.getScreenSizeAsync(context.serial);
    const sendX = Math.round(screenWidth * 0.92);
    const sendY = Math.round(screenHeight * 0.9);
    context.onLog(`Upload a Video: tapping Send at (${sendX},${sendY}) on ${screenWidth}×${screenHeight}.`);
    await android.tap(
      context.serial,
      sendX,
      sendY,
      "bot",
      `Snapchat: send video to ${selectedAudience} with the bottom-right chevron`,
      "automation",
      { exact: true },
    );
    await context.sleep(3_000, "exact");
    context.onLog(`Upload a Video: sent "${fileName}" to ${selectedAudience}.`);
    context.onMetric?.("snapchat_uploads");
    context.onLog("Upload a Video: letting Send settle, then pressing Android Back three times with pauses between presses.");
    for (let press = 1; press <= 3; press++) {
      try {
        await android.keyevent(context.serial, 4);
        context.onLog(`Upload a Video: Android Back press ${press}/3 sent.`);
      } catch (error) {
        context.onLog(`Upload a Video: Android Back press ${press}/3 failed: ${error instanceof Error ? error.message : "unknown error"}.`);
      }
      await context.sleep(press < 3 ? 2_500 : 2_000, "exact");
    }
    return "completed";
  } catch (error) {
    context.onLog(`Upload a Video stopped: ${error instanceof Error ? error.message : "video staging or navigation failed"}.`);
    return "failed";
  } finally {
    if (devicePath) {
      try {
        await android.removeDeviceFileStrict(context.serial, devicePath);
        context.onLog("Upload a Video: removed the staged phone copy; the PC source remains.");
      } catch (error) {
        context.onLog(`Upload a Video: could not remove the staged phone video: ${error instanceof Error ? error.message : "unknown error"}.`);
      }
    }
  }
}

export async function runUploadVideo(context: SnapchatContext): Promise<UploadVideoResult> {
  const settings = context.tools.uploadVideo;
  if (!settings.enabled || !settings.directoryPath.trim()) return "not-started";
  if (settings.addLink && !settings.linkUrl.trim()) {
    context.onLog("Upload a Video skipped: Add a link is enabled but the link field is empty.");
    return "not-started";
  }

  const requestedAmount = randomCount(settings.min, settings.max);
  if (requestedAmount < 1) {
    context.onLog("Upload a Video skipped: the selected amount is zero.");
    return "not-started";
  }

  const usedFileNames: string[] = [];
  let completed = 0;
  for (let index = 0; index < requestedAmount; index++) {
    if (context.isAborted()) return completed > 0 ? "completed" : "not-started";
    const fileName = await context.pickLocalFolderVideo(context.serial, {
      folderPath: settings.directoryPath,
      random: settings.selectAtRandom,
      excludeFileNames: usedFileNames,
      onLog: context.onLog,
    });
    if (!fileName) {
      if (completed === 0) return "not-started";
      context.onLog(`Upload a Video: completed ${completed} of ${requestedAmount}; no more unused videos were available.`);
      return "completed";
    }
    usedFileNames.push(fileName);
    context.onLog(`Upload a Video: starting video ${index + 1} of ${requestedAmount}.`);
    const result = await uploadOneVideo(context, fileName);
    if (result !== "completed") return result;
    completed++;
  }
  return "completed";
}
