import * as android from "../../../androidManager";
import type { SnapchatContext, UiNode } from "../context";
import { center, dump, shortResourceId, tapNode } from "../runtime";
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

    let memoriesReady = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      state = await dump(context.serial);
      if (/id="memories_grid"/i.test(state.xml)) {
        memoriesReady = true;
        break;
      }
      if (attempt < 9) await context.sleep(500, "exact");
    }
    if (!memoriesReady) {
      context.onLog("Upload a Snap stopped: Snapchat Memories did not open after tapping its Camera icon.");
      return "failed";
    }

    const cameraRollTab = findLabeledControl(state.nodes, "camera roll");
    if (!cameraRollTab || !await tapNode(context, cameraRollTab, "open the Camera Roll tab")) {
      context.onLog("Upload a Snap stopped: the Camera Roll tab was not available in Memories.");
      return "failed";
    }

    let galleryReady = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      state = await dump(context.serial);
      if (/id="grid_frameable_container"/i.test(state.xml)) {
        galleryReady = true;
        break;
      }
      if (attempt < 9) await context.sleep(500, "exact");
    }
    if (!galleryReady) {
      context.onLog("Upload a Snap stopped: no Camera Roll gallery image was available to select.");
      return "failed";
    }

    const firstImage = state.nodes
      .filter(node => shortResourceId(node) === "grid_frameable_container")
      .sort((a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0])[0];
    if (!firstImage || !await tapNode(context, firstImage, "select the first Camera Roll gallery image")) {
      context.onLog("Upload a Snap stopped: the first Camera Roll image could not be selected.");
      return "failed";
    }

    let imageOpened = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      state = await dump(context.serial);
      if (!/id="memories_grid"/i.test(state.xml)) {
        imageOpened = true;
        break;
      }
      if (attempt < 9) await context.sleep(500, "exact");
    }
    if (!imageOpened) {
      context.onLog("Upload a Snap stopped: tapping the first image did not leave the Camera Roll; no further control was guessed.");
      return "failed";
    }

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
      const okayButton = state.nodes.find(node =>
        node.text.trim().toLowerCase() === "okay" ||
        node.desc.trim().toLowerCase() === "okay",
      );
      if (okayButton) {
        await tapNode(context, okayButton, "dismiss Public Story notice with Okay", 0, true);
        context.onLog("Upload a Snap: dismissed the Public Story notice with Okay.");
      } else {
        context.onLog("Upload a Snap: Public Story notice appeared, but its Okay button was not exposed.");
      }
    }

    state = await dump(context.serial);
    const sendButton = state.nodes.find(node =>
      shortResourceId(node) === "send_to_send_button",
    );
    if (!sendButton || !await tapNode(context, sendButton, "send Snap to My Story - Public")) {
      context.onLog("Upload a Snap stopped: Snapchat's Send arrow was not available after selecting My Story - Public.");
      return "failed";
    }

    context.onLog(`Upload a Snap: tapped Send for "${fileName}" to My Story - Public.`);
    context.onLog("Upload a Snap: pressing Android Back twice after Send.");
    for (let press = 1; press <= 2; press++) {
      try {
        await android.keyevent(context.serial, 4);
        context.onLog(`Upload a Snap: Android Back press ${press}/2 sent.`);
      } catch (error) {
        context.onLog(`Upload a Snap: Android Back press ${press}/2 failed: ${error instanceof Error ? error.message : "unknown error"}.`);
      }
      if (press < 2) await context.sleep(250, "exact");
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
