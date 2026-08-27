/** Isolated mobile HST Post a Story operation. */
export interface PostStoryOperationContext {
  android: any;
  path: any;
  fsPromises: any;
  sleepOrAbort: (serial: string, ms: number) => Promise<void>;
  pickLocalFolderImage: (serial: string, opts: any) => Promise<string | null>;
  prepareMakePostImage: (localPath: string, fileName: string, opts: any) => Promise<any>;
  auditDeviceMediaCopy: (...args: any[]) => Promise<any>;
  recordPostedLocalFile: (...args: any[]) => void;
  slotIdx: number;
}

export async function runMakePostStoryStep(serial: string, opts: {
  localFolderPath: string; localFolderRandom: boolean; localFolderNoRepeat: boolean;
  deleteAfterUpload: boolean;
  doFixAiSlop?: boolean;
  alterationEnabled?: any;
  alterationLevel?: any;
  imageSettingsEnabled?: boolean;
  imageSettings?: any;
  onLog?: (msg: string) => void;
}, context: PostStoryOperationContext): Promise<{ posted: boolean; fileName?: string }> {
  const { android, path, fsPromises, sleepOrAbort, pickLocalFolderImage,
    prepareMakePostImage, auditDeviceMediaCopy, recordPostedLocalFile, slotIdx } = context;
  const {
    localFolderPath, localFolderRandom, localFolderNoRepeat, deleteAfterUpload,
    doFixAiSlop, alterationEnabled, alterationLevel,
    imageSettingsEnabled, imageSettings, onLog,
  } = opts;

  const fileName = await pickLocalFolderImage(serial, {
    folderPath: localFolderPath, random: localFolderRandom, noRepeat: localFolderNoRepeat, slotIdx, onLog,
  });
  if (!fileName) return { posted: false };
  const localFilePath = path.join(localFolderPath, fileName);

  const prepared = await prepareMakePostImage(localFilePath, fileName, {
    doFixAiSlop,
    alterationEnabled,
    alterationLevel,
    imageSettingsEnabled,
    imageSettings,
    onLog: (msg: string) => onLog?.(msg.replace("Make a Post:", "Make a Post (Story):")),
  });

  onLog?.(`Make a Post (Story): pushing "${fileName}" to device…`);
  let devicePath: string;
  try {
    devicePath = await android.pushFileToDevice(serial, prepared.pushFilePath, prepared.pushFileName);
  } catch (e: any) {
    await prepared.cleanup();
    onLog?.(`Make a Post (Story): adb push failed — ${e?.message ?? "unknown error"}`);
    return { posted: false };
  }
  await prepared.cleanup();
  await auditDeviceMediaCopy(serial, devicePath, prepared.audit, onLog);
  onLog?.(`Make a Post (Story): ✓ pushed to ${devicePath} — processedSha256=${prepared.audit.processedSha256} filename=${prepared.pushFileName} bytes=${prepared.audit.processedBytes}`);
  await sleepOrAbort(serial, 1200);

  onLog?.("Make a Post (Story): using calibrated \"+\" compose icon…");
  const composeBtn = await android.tapCalibratedNavigationControl(serial, "createPost", onLog);
  onLog?.("Make a Post (Story): tapping the \"+\" compose icon…");
  await sleepOrAbort(serial, 3500);
  await android.logScreenLayout(serial, "Make a Post (Story): after '+' tap", onLog);
  await android.dismissInstagramInterstitials(serial).catch(() => null);

  onLog?.("Make a Post (Story): looking for the STORY tab…");
  const storyTab = await android.findButtonByLabel(serial, "STORY").catch(() => null)
    ?? await android.findButtonByLabel(serial, "Story").catch(() => null);
  if (!storyTab) {
    onLog?.("Make a Post (Story): STORY tab not found in compose sheet — aborting");
    await android.pressBack(serial);
    await android.removeDeviceFile(serial, devicePath).catch(() => {});
    return { posted: false };
  }
  onLog?.(`Make a Post (Story): tapping STORY tab at (${storyTab.x}, ${storyTab.y})…`);
  await android.tap(serial, storyTab.x, storyTab.y);
  await sleepOrAbort(serial, 2500);
  await android.logScreenLayout(serial, "Make a Post (Story): after STORY tab tap", onLog);

  onLog?.("Make a Post (Story): looking for gallery icon…");
  const galleryBtn = await android.findStoryGalleryButton(serial).catch(() => null);
  if (!galleryBtn) {
    onLog?.("Make a Post (Story): gallery icon not found — aborting");
    await android.pressBack(serial);
    await android.removeDeviceFile(serial, devicePath).catch(() => {});
    return { posted: false };
  }
  onLog?.(`Make a Post (Story): tapping gallery icon at (${galleryBtn.x}, ${galleryBtn.y})…`);
  await android.tap(serial, galleryBtn.x, galleryBtn.y);
  await sleepOrAbort(serial, 1500);
  await android.logScreenLayout(serial, "Make a Post (Story): after gallery tap", onLog);

  onLog?.("Make a Post (Story): looking for most recent photo thumbnail…");
  const thumbnail = await android.findFirstStoryGalleryThumbnail(serial).catch(() => null);
  if (!thumbnail) {
    onLog?.("Make a Post (Story): no photo thumbnail found in story gallery — aborting");
    await android.pressBack(serial);
    await android.pressBack(serial);
    await android.removeDeviceFile(serial, devicePath).catch(() => {});
    return { posted: false };
  }
  onLog?.(`Make a Post (Story): tapping thumbnail at (${thumbnail.x}, ${thumbnail.y})…`);
  await android.tap(serial, thumbnail.x, thumbnail.y);
  await sleepOrAbort(serial, 1500);
  await android.logScreenLayout(serial, "Make a Post (Story): after thumbnail tap", onLog);

  onLog?.("Make a Post (Story): looking for the forward arrow button…");
  const arrowBtn = await android.findStoryNextArrowButton(serial).catch(() => null);
  let shareTappedDirectly = false;
  if (!arrowBtn) {
    onLog?.("Make a Post (Story): forward arrow node not found — checking for direct Share node…");
    const directShareBtn = await android.findStoryShareButton(serial).catch(() => null);
    if (!directShareBtn) {
      onLog?.("Make a Post (Story): forward arrow/Share node not found — aborting");
      await android.pressBack(serial);
      await android.pressBack(serial);
      await android.removeDeviceFile(serial, devicePath).catch(() => {});
      return { posted: false };
    }
    onLog?.(`Make a Post (Story): tapping direct Share at (${directShareBtn.x}, ${directShareBtn.y})…`);
    await android.tap(serial, directShareBtn.x, directShareBtn.y);
    shareTappedDirectly = true;
  } else {
    onLog?.(`Make a Post (Story): tapping forward/share node at (${arrowBtn.x}, ${arrowBtn.y})…`);
    await android.tap(serial, arrowBtn.x, arrowBtn.y);
    shareTappedDirectly = !!arrowBtn.directShare;
  }
  if (!shareTappedDirectly) await sleepOrAbort(serial, 1500);
  await android.logScreenLayout(serial, "Make a Post (Story): after arrow tap", onLog);

  if (!shareTappedDirectly) {
    onLog?.("Make a Post (Story): looking for Share button…");
    const shareBtn = await android.findStoryShareButton(serial).catch(() => null);
    if (!shareBtn) {
      onLog?.("Make a Post (Story): Share button not found — aborting");
      await android.pressBack(serial);
      await android.removeDeviceFile(serial, devicePath).catch(() => {});
      return { posted: false };
    }
    onLog?.(`Make a Post (Story): tapping Share at (${shareBtn.x}, ${shareBtn.y})…`);
    await android.tap(serial, shareBtn.x, shareBtn.y);
  } else {
    onLog?.("Make a Post (Story): direct Share node submitted the story");
  }
  await sleepOrAbort(serial, 2000);
  await android.logScreenLayout(serial, "Make a Post (Story): after Share tap", onLog);

  onLog?.("Make a Post (Story): looking for Finished button…");
  const finishedBtn = await android.findStoryFinishedButton(serial).catch(() => null);
  if (finishedBtn) {
    onLog?.(`Make a Post (Story): tapping Finished at (${finishedBtn.x}, ${finishedBtn.y})…`);
    await android.tap(serial, finishedBtn.x, finishedBtn.y);
    await sleepOrAbort(serial, 1500);
  } else {
    onLog?.("Make a Post (Story): Finished button not found — story may already be live");
  }

  const archiveDismissed = await android.dismissStoriesArchivePopup(serial).catch(() => false);
  if (archiveDismissed) onLog?.("Make a Post (Story): dismissed Stories archive popup");
  await android.dismissInstagramInterstitials(serial).catch(() => null);

  recordPostedLocalFile(serial, slotIdx, fileName);
  if (deleteAfterUpload) {
    try { await fsPromises.unlink(localFilePath); } catch { /* best effort */ }
  }
  await android.removeDeviceFile(serial, devicePath).catch(() => {});
  onLog?.(`Make a Post (Story): ✓ story posted "${fileName}"`);
  return { posted: true, fileName };
}