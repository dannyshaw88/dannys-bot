/** Isolated mobile HST Update Profile Picture operation. */
export interface UpdateProfilePictureOperationContext {
  android: any;
  fs: typeof import("fs");
  path: typeof import("path");
  prepareMakePostImage: (localPath: string, fileName: string, opts: any) => Promise<any>;
  auditDeviceMediaCopy: (...args: any[]) => Promise<any>;
  sleepOrAbort: (serial: string, ms: number, category?: any) => Promise<void>;
  logger?: any;
  isCycleAborted?: (serial: string) => boolean;
  detectors?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  sharedSlotState?: Map<string, unknown>;
}

export async function runUpdateProfilePicture(
  serial: string,
  folderPath: string,
  onLog: ((msg: string) => void) | undefined,
  imageOptions: {
    alterationEnabled?: boolean; alterationLevel?: any; imageSettingsEnabled?: boolean;
    imageSettings?: any; fixAiSlop?: boolean; metadataCleanup?: boolean; frequencyDisruption?: boolean;
  } | undefined,
  context: UpdateProfilePictureOperationContext,
): Promise<void> {
  const { android, fs, path, prepareMakePostImage, auditDeviceMediaCopy, sleepOrAbort } = context;

    // 1. Pick the most recent image file from the PC folder.
    let files: { name: string; mtime: number }[] = [];
    try {
      files = fs.readdirSync(folderPath)
        .filter(f => /\.(jpe?g|png|webp)$/i.test(f))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(folderPath, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    } catch (e: any) {
      onLog?.(`Update Profile Pic: ✗ could not read folder: ${e?.message}`); return;
    }
    if (!files.length) { onLog?.("Update Profile Pic: ✗ no images found in folder"); return; }
    const localFile = files[0].name;
    const localPath = path.join(folderPath, localFile);
    let prepared: Awaited<ReturnType<typeof prepareMakePostImage>> | undefined;
    let actualDevicePath: string | undefined;
    try {

    // 2. Prepare the source using the same image pipeline as Make a Post.
    // Only the processed copy is sent to the phone; both local copies are
    // cleaned up in the outer finally block after this selected attempt.
    try {
      prepared = await prepareMakePostImage(localPath, localFile, {
        doFixAiSlop: imageOptions?.fixAiSlop ?? false,
        alterationEnabled: imageOptions?.alterationEnabled ?? true,
        alterationLevel: imageOptions?.alterationLevel ?? "small",
        imageSettingsEnabled: imageOptions?.imageSettingsEnabled ?? true,
        imageSettings: imageOptions?.imageSettings,
        frequencyDisruption: imageOptions?.frequencyDisruption ?? false,
      // The preparation pipeline is shared with Make a Post, but this caller
      // is Update Profile Pic. Relabel delegated progress lines so Random
      // Actions cannot misreport an avatar update as a post.
      onLog: (msg: string) => onLog?.(msg.replace(/^Make a Post:/, "Update Profile Pic:")),
      });
    } catch (e: any) {
      onLog?.(`Update Profile Pic: ✗ image preparation failed: ${e?.message}`);
      return;
    }

    // Keep the exact generated destination so cleanup can remove this staged
    // image, including a partial destination if the transfer fails.
    try {
      actualDevicePath = await android.pushFileToDevice(serial, prepared.pushFilePath, prepared.pushFileName, true, true);
      onLog?.(`Update Profile Pic: pushed ${localFile} to device — processedSha256=${prepared.audit.processedSha256} filename=${prepared.pushFileName} bytes=${prepared.audit.processedBytes}`);
    } catch (e: any) {
      actualDevicePath = typeof e?.partialDevicePath === "string" ? e.partialDevicePath : undefined;
      onLog?.(`Update Profile Pic: ✗ push failed: ${e?.message}`);
      if (e?.deviceCleanupError) {
        onLog?.(`Update Profile Pic: ⚠ partial phone copy cleanup failed: ${e.deviceCleanupError}`);
      }
      return;
    }
    await auditDeviceMediaCopy(serial, actualDevicePath, prepared.audit, onLog);
    await sleepOrAbort(serial, 1000);

    // 3. Tap the profile tab (bottom-right, tab_avatar).
    {
      const xml = await android.dumpUi(serial);
      const m = xml.match(/resource-id="[^"]*tab_avatar[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!m) { onLog?.("Update Profile Pic: ✗ profile tab not found"); return; }
      await android.tap(serial, Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2));
      onLog?.("Update Profile Pic: tapped profile tab");
    }
    await sleepOrAbort(serial, 1800 + Math.round(Math.random() * 400));

    // 4. Tap the "Edit profile" button.
    {
      const xml = await android.dumpUi(serial);
      const m = xml.match(/desc="Edit profile"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ||
                xml.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*desc="Edit profile"/);
      if (!m) { onLog?.("Update Profile Pic: ✗ Edit profile button not found"); await android.pressBack(serial); return; }
      await android.tap(serial, Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2));
      onLog?.("Update Profile Pic: tapped Edit profile");
    }
    await sleepOrAbort(serial, 1800 + Math.round(Math.random() * 400));

    // 5. Verify Edit Profile page is loaded, then tap "Edit pictures".
    {
      const xml = await android.dumpUi(serial);
      if (!xml.includes("edit_profile_fields") && !xml.includes("change_avatar_button")) {
        onLog?.("Update Profile Pic: ✗ Edit Profile page did not load"); await android.pressBack(serial); return;
      }
      const m = xml.match(/resource-id="[^"]*change_avatar_button[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!m) { onLog?.("Update Profile Pic: ✗ Edit pictures button not found"); await android.pressBack(serial); return; }
      await android.tap(serial, Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2));
      onLog?.("Update Profile Pic: tapped Edit pictures");
    }
    await sleepOrAbort(serial, 1800 + Math.round(Math.random() * 400));

    // 6. Handle whichever UI Instagram shows after "Edit picture or avatar".
    //
    //    Layout A (older builds): the mpp overlay opens directly, showing a
    //    dotted-ring "+" add slot (resource-id mpp_left). Tap it to open the
    //    gallery picker.
    //
    //    Layout B (newer builds — observed Jul 2026): a bottom sheet appears
    //    first with three options: "Choose from library", "Import from
    //    Facebook", "Take Photo" (resource-id update_profile_options_list).
    //    We must tap "Choose from library" to reach the gallery picker;
    //    the mpp_left button is never shown in this path.
    //
    //    Both layouts are detected from one dump so no extra round-trip is
    //    needed. After handling either path, execution falls through to step 7
    //    (gallery picker check), which is the same regardless of which layout
    //    was shown.
    {
      const xml = await android.dumpUi(serial);
      const hasPhotoSheet =
        xml.includes("update_profile_options_list") ||
        xml.includes("update_profile_picture_tab_layout") ||
        xml.includes('desc="Choose from library"');

      if (hasPhotoSheet) {
        // Layout B — tap "Choose from library".
        const m = xml.match(/desc="Choose from library"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ||
                  xml.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*desc="Choose from library"/);
        if (!m) {
          onLog?.("Update Profile Pic: ✗ 'Choose from library' button not found in photo sheet");
          await android.pressBack(serial); return;
        }
        await android.tap(serial, Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2));
        onLog?.("Update Profile Pic: tapped 'Choose from library' (photo sheet layout)");
      } else {
        // Layout A — tap the "+" add slot (mpp_left).
        const m = xml.match(/resource-id="[^"]*mpp_left[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (!m) { onLog?.("Update Profile Pic: ✗ mpp_left (+) button not found"); await android.pressBack(serial); return; }
        await android.tap(serial, Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2));
        onLog?.("Update Profile Pic: tapped + (mpp_left) button");
      }
    }
    await sleepOrAbort(serial, 1800 + Math.round(Math.random() * 400));

    // 7. Confirm the "Add profile pictures" gallery screen loaded.
    {
      const xml = await android.dumpUi(serial);
      if (!xml.includes("gallery_picker_view") && !xml.includes("Add profile pictures")) {
        onLog?.("Update Profile Pic: ✗ gallery picker did not open"); await android.pressBack(serial); return;
      }
      onLog?.("Update Profile Pic: gallery picker opened");
    }

    // 8. Tap the most recent photo — first gallery_grid_item_thumbnail in the dump.
    {
      const xml = await android.dumpUi(serial);
      const m = xml.match(/resource-id="[^"]*gallery_grid_item_thumbnail[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!m) { onLog?.("Update Profile Pic: ✗ gallery thumbnail not found"); await android.pressBack(serial); return; }
      await android.tap(serial, Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2));
      onLog?.("Update Profile Pic: selected most recent photo");
    }
    await sleepOrAbort(serial, 1000 + Math.round(Math.random() * 500));

    // 9. Tap "Finished".
    {
      const xml = await android.dumpUi(serial);
      const m = xml.match(/resource-id="[^"]*next_button_textview[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ||
                xml.match(/text="Finished"[^/]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!m) { onLog?.("Update Profile Pic: ✗ Finished button not found"); await android.pressBack(serial); return; }
      await android.tap(serial, Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2));
      onLog?.("Update Profile Pic: tapped Finished");
    }
    const postFinishedDwellMs = 7500 + Math.floor(Math.random() * 10) * 500;
    onLog?.(`Update Profile Pic: dwelling ${postFinishedDwellMs / 1000}s after Finished before Back`);
    await sleepOrAbort(serial, postFinishedDwellMs);

    // 10. Tap the calibrated Instagram Back control once to leave the
    // edit-profile view. This is the same upper-left control captured in
    // Mirror Controls, and fails closed when calibration is missing/stale.
    const calibratedBack = await android.tapCalibratedNavigationControl(
      serial,
      "settingsBack",
      (message: string) => onLog?.(`Update Profile Pic: ${message}`),
    );
    await sleepOrAbort(serial, 800 + Math.round(Math.random() * 400));
    onLog?.(`Update Profile Pic: tapped calibrated Instagram Back at (${calibratedBack.x},${calibratedBack.y})`);

    } finally {
      // Always remove the staged image, even if preparation, pushing, media
      // auditing, or Instagram navigation fails. pushFileToDevice exposes a
      // partial destination on transfer failure so it can be retried here.
      if (actualDevicePath) {
        try {
          await android.removeDeviceFileStrict(serial, actualDevicePath);
          onLog?.(`Update Profile Pic: deleted ${localFile} from device`);
        } catch (e: any) {
          onLog?.(`Update Profile Pic: ⚠ could not delete device file: ${e?.message}`);
        }
      }
      if (prepared) {
        try {
          await prepared.cleanup();
        } catch (e: any) {
          onLog?.(`Update Profile Pic: ⚠ could not clean up processed PC copy: ${e?.message}`);
        }
      }

      // The selected source is consumed by this attempt, not only by a
      // successful avatar change. Remove it so the newest-file picker cannot
      // choose it again on the next Random Actions cycle.
      let sourceAlreadyAbsent = false;
      try {
        fs.unlinkSync(localPath);
      } catch (e: any) {
        if (e?.code === "ENOENT") sourceAlreadyAbsent = true;
        else onLog?.(`Update Profile Pic: ⚠ could not delete PC file: ${e?.message}`);
      }
      if (fs.existsSync(localPath)) {
        onLog?.(`Update Profile Pic: ⚠ PC source still exists and may be selected again: ${localPath}`);
      } else if (sourceAlreadyAbsent) {
        onLog?.(`Update Profile Pic: PC source was already absent: ${localFile}`);
      } else {
        onLog?.(`Update Profile Pic: deleted ${localFile} from PC`);
      }
    }

    onLog?.("Update Profile Pic: ✓ done");
}
