/** Isolated mobile HST Update Bio operation. */
export interface UpdateBioOperationContext {
  android: any;
  sleepOrAbort: (serial: string, ms: number, category?: any) => Promise<void>;
  effectiveTypingProfile: (serial: string) => any;
  logger?: any;
  isCycleAborted?: (serial: string) => boolean;
  detectors?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  sharedSlotState?: Map<string, unknown>;
}

function resolveSpinSyntax(text: string): string {
  return text.replace(/\{([^{}]+)\}/g, (_, inner: string) => {
    const parts = inner.split("|");
    return parts[Math.floor(Math.random() * parts.length)];
  });
}

export async function runUpdateBio(
  serial: string,
  bioText: string,
  onLog: ((msg: string) => void) | undefined,
  context: UpdateBioOperationContext,
): Promise<void> {
  const { android, sleepOrAbort, effectiveTypingProfile } = context;
  const originalBioText = bioText;
    onLog?.(`Update Bio: input received — length=${originalBioText.length}, value=${JSON.stringify(originalBioText)}`);
    if (!bioText.trim()) { onLog?.("Update Bio: ✗ bio text is empty — skipping"); return; }
    // Normalize textarea/API line endings before resolving spin groups. Saved
    // settings can contain Windows CRLF (or legacy bare CR) line breaks; the
    // calibrated keyboard path intentionally maps newline only to Enter.
    bioText = bioText.replace(/\r\n?/g, "\n");
    // Resolve spin syntax before typing — each {a|b|c} group is rolled independently.
    bioText = resolveSpinSyntax(bioText);
    onLog?.(`Update Bio: spin resolved — inputLength=${originalBioText.length}, outputLength=${bioText.length}, value=${JSON.stringify(bioText)}, spinGroupsRemaining=${(bioText.match(/\{[^{}]*\}/g) ?? []).length}`);

    // 1. Tap the profile tab (bottom-right, tab_avatar).
    {
      const xml = await android.dumpUi(serial);
      const m = xml.match(/resource-id="[^"]*tab_avatar[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!m) { onLog?.("Update Bio: ✗ profile tab not found"); return; }
      await android.tap(serial, Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2));
      onLog?.("Update Bio: tapped profile tab");
    }
    await sleepOrAbort(serial, 1800 + Math.round(Math.random() * 400));

    // 2. Tap the "Edit profile" button.
    {
      const xml = await android.dumpUi(serial);
      const m = xml.match(/(?:desc|text|content-desc)="Edit profile"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i) ||
                xml.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*(?:desc|text|content-desc)="Edit profile"/i) ||
                xml.match(/resource-id="[^"]*(?:edit_profile|edit_profile_button)[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i);
      if (!m) { onLog?.("Update Bio: ✗ Edit profile button not found"); await android.pressBack(serial); return; }
      await android.tap(serial, Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2));
    }
    await sleepOrAbort(serial, 1800 + Math.round(Math.random() * 400));

    // 3. Verify Edit Profile page loaded, then tap the bio field.
    {
      const xml = await android.dumpUi(serial);
      if (!xml.includes("edit_profile_fields") && !xml.includes("prism_form_field_container")) {
        onLog?.("Update Bio: ✗ Edit Profile page did not load after verified Edit profile-node tap");
        await android.pressBack(serial); return;
      }
      onLog?.("Update Bio: ✓ Edit Profile page loaded after verified Edit profile-node tap");
      // The bio section is a Button with resource-id ending in "bio"; its
      // EditText child is what we tap to place the cursor.
      const m = xml.match(/resource-id="[^"]*\bbio\b[^"]*"[^/]*\/?>[\s\S]*?<[^>]*EditText[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ||
                xml.match(/resource-id="[^"]*\bbio\b[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!m) { onLog?.("Update Bio: ✗ bio field not found in Edit Profile"); await android.pressBack(serial); return; }
      await android.tap(serial, Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2));
      onLog?.("Update Bio: tapped bio field");
    }
    // Wait for the dedicated Bio edit screen to open (it's a separate screen from Edit Profile).
    await sleepOrAbort(serial, 1400 + Math.round(Math.random() * 300));

    // 3b. Re-dump the Bio edit screen and tap the EditText directly to establish
    //     a proper input connection. On MIUI/Android 13 the previous tap (on the
    //     Edit Profile page) opens the Bio screen but the input method service
    //     hasn't bound to the new field yet — calling inputText immediately causes
    //     a NullPointerException in InputShellCommand.sendText. Tapping the field
    //     from the Bio screen's own dump forces Android to initialise the input
    //     connection before we try to type.
    {
      const bioXml = await android.dumpUi(serial);
      // `prism_form_field_container` is also present on the surrounding Edit
      // Profile form, so it cannot prove that the dedicated Bio screen opened.
      // Require the Bio screen's own layout marker before looking for an
      // EditText. This prevents the first EditText on Edit Profile (Name)
      // from being mistaken for the Bio field.
      if (bioXml.includes("edit_bio_layout")) {
        // Tap the EditText (the actual text field, not the outer container).
        const et = bioXml.match(/\bEditText\b[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (et) {
          await android.tap(serial, Math.round((+et[1] + +et[3]) / 2), Math.round((+et[2] + +et[4]) / 2));
          onLog?.("Update Bio: confirmed focus on Bio edit screen");
          await sleepOrAbort(serial, 500);
        }
      } else {
        onLog?.("Update Bio: ⚠ Bio edit screen did not open — pressing Back");
        await android.pressBack(serial); return;
      }
    }

    // 4. Replace the focused Bio field through the saved per-device keyboard
    //    calibration map. First select all existing content and clear it;
    //    typing must never begin in a field containing stale Bio text.
    {
      try {
        const beforeClearXml = await android.dumpUi(serial);
        const focusedField = [...beforeClearXml.matchAll(/<node\b[^>]*class="android\.widget\.EditText"[^>]*>/gi)]
          .map(match => match[0])
          .find(node => /focused="true"/i.test(node));
        const existingBio = focusedField?.match(/\btext="([^"]*)"/i)?.[1] ?? "";
        onLog?.(`Update Bio: focused field detected=${Boolean(focusedField)}, existingLength=${existingBio.length}`);
        if (existingBio.length > 0) {
          onLog?.("Update Bio: clearing existing Bio — select-all then delete");
          await android.clearFocusedTextField(
            serial,
            (message: string) => onLog?.(`Update Bio: ${message}`),
          );
          const clearedXml = await android.dumpUi(serial);
          const clearedField = [...clearedXml.matchAll(/<node\b[^>]*class="android\.widget\.EditText"[^>]*>/gi)]
            .map(match => match[0])
            .find(node => /focused="true"/i.test(node));
          const remaining = clearedField?.match(/\btext="([^"]*)"/i)?.[1] ?? "";
          onLog?.(`Update Bio: clear verification — focusedEditTextFound=${Boolean(clearedField)}, remainingLength=${remaining.length}, remainingValue=${JSON.stringify(remaining)}`);
          if (remaining.length > 0) {
            onLog?.(`Update Bio: ✗ clear verification found ${remaining.length} remaining characters — aborting`);
            await android.pressBack(serial);
            return;
          }
          onLog?.("Update Bio: ✓ existing Bio text cleared and verified");
        } else {
          onLog?.("Update Bio: field is already empty — skipping select-all/delete");
        }
      } catch (e: any) {
        onLog?.(`Update Bio: ✗ could not select/clear existing Bio text — ${e?.message ?? String(e)}`);
        await android.pressBack(serial);
        return;
      }
      onLog?.(`Update Bio: typing start — length=${bioText.length}, value=${JSON.stringify(bioText)}`);
      const typed = await android.typeViaSavedCalibrationMap(
        serial,
        bioText,
        effectiveTypingProfile(serial),
        (message: string) => onLog?.(`Update Bio: ${message}`),
        // Bio text must be entered exactly as generated. Human-error
        // simulation types a random character and then presses Backspace;
        // on Gboard that destructive correction can race the prior tap and
        // delete a real character/word while still reporting ok=true.
        { debugLabel: "Update Bio", disableHumanErrors: true },
      );
      if (!typed.ok) {
        onLog?.(`Update Bio: ✗ calibrated typing incomplete — missing ${typed.missing.join(", ") || "required calibration"}`);
        await android.pressBack(serial);
        return;
      }
      onLog?.(`Update Bio: typing result — ok=${typed.ok}, calibrationAvailable=${typed.available}, missing=${typed.missing.join(",") || "none"}`);
      onLog?.(`Update Bio: entered bio text via keyboard calibration (${bioText.length} chars)`);
    }
    await sleepOrAbort(serial, 800 + Math.round(Math.random() * 200));

    // 5. Tap the "Finished" tick in the top-right of the Bio edit screen action bar,
    //    then fall back to broader Save/Submit/Done matches for other IG builds.
    {
      const xml = await android.dumpUi(serial);
      // Primary: action_bar_button_action with desc="Finished" (Bio edit screen — confirmed via dump).
      // Secondary: desc="Submit" or text="Done" for other IG builds.
      const m = xml.match(/id="[^"]*action_bar_button_action[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ||
                xml.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*id="[^"]*action_bar_button_action[^"]*"/) ||
                xml.match(/desc="Finished"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ||
                xml.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*desc="Finished"/) ||
                xml.match(/desc="Submit"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ||
                xml.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*desc="Submit"/) ||
                xml.match(/text="Done"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ||
                xml.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*text="Done"/);
      if (m) {
        await android.tap(serial, Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2));
        onLog?.("Update Bio: tapped Finished/Save button");
      } else {
        // Fallback: tap the right side of the action bar (Finished tick is always there).
        const ab = xml.match(/resource-id="[^"]*action_bar\b[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (ab) {
          // Right ~10% of the action bar, vertically centered.
          const x = Math.round(+ab[3] - (+ab[3] - +ab[1]) * 0.07);
          const y = Math.round((+ab[2] + +ab[4]) / 2);
          await android.tap(serial, x, y);
          onLog?.("Update Bio: tapped action bar right edge (Finished fallback)");
        } else {
          onLog?.("Update Bio: ⚠ could not find Finished button — pressing Back without saving");
          await android.pressBack(serial); return;
        }
      }
    }
    await sleepOrAbort(serial, 1500 + Math.round(Math.random() * 300));

    // 6. Leave the surrounding Edit Profile surface by locating the live
    // top-left back arrow. Do not use Android Back or a guessed coordinate:
    // on some builds the save flow leaves this screen open and the next
    // random action then runs against Edit Profile indefinitely.
    const backIcon = await android.findBackHeaderIconByPixels(
      serial,
      (message: string) => onLog?.(`Update Bio: ${message}`),
    );
    if (!backIcon) {
      onLog?.("Update Bio: ✗ top-left back arrow was not visually confirmed — stopping without fallback");
      return;
    }
    await android.tap(serial, backIcon.x, backIcon.y);
    await sleepOrAbort(serial, 800);
    onLog?.(`Update Bio: tapped visually confirmed back arrow at (${backIcon.x},${backIcon.y})`);
    onLog?.("Update Bio: ✓ done");
}
