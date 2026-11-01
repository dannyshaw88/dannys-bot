import * as android from "../../../androidManager";
import type { SnapchatContext } from "../context";
import { dump, shortResourceId, tapNode } from "../runtime";
import { openUploadSnapCamera } from "../navigation/openUploadSnapCamera";
import { tapUploadSnapMemories } from "../navigation/tapUploadSnapMemories";

export type UploadSnapResult = "not-started" | "selected" | "failed";

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
      await android.removeDeviceFile(context.serial, devicePath).catch(() => {});
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
      await android.removeDeviceFile(context.serial, devicePath).catch(() => {});
      return "failed";
    }

    const cameraRollTab = state.nodes.find(node =>
      node.text.trim().toLowerCase() === "camera roll" ||
      node.desc.trim().toLowerCase() === "camera roll",
    );
    if (!cameraRollTab || !await tapNode(context, cameraRollTab, "open the Camera Roll tab")) {
      context.onLog("Upload a Snap stopped: the Camera Roll tab was not available in Memories.");
      await android.removeDeviceFile(context.serial, devicePath).catch(() => {});
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
      await android.removeDeviceFile(context.serial, devicePath).catch(() => {});
      return "failed";
    }

    const firstImage = state.nodes
      .filter(node => shortResourceId(node) === "grid_frameable_container")
      .sort((a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0])[0];
    if (!firstImage || !await tapNode(context, firstImage, "select the first Camera Roll gallery image")) {
      context.onLog("Upload a Snap stopped: the first Camera Roll image could not be selected.");
      await android.removeDeviceFile(context.serial, devicePath).catch(() => {});
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
      await android.removeDeviceFile(context.serial, devicePath).catch(() => {});
      return "failed";
    }

    context.onLog(`Upload a Snap: selected the first Camera Roll image from "${fileName}". Leaving Snapchat on this screen for testing.`);
    return "selected";
  } catch (error) {
    context.onLog(`Upload a Snap stopped: ${error instanceof Error ? error.message : "image staging or navigation failed"}.`);
    if (devicePath) await android.removeDeviceFile(context.serial, devicePath).catch(() => {});
    return "failed";
  }
}
