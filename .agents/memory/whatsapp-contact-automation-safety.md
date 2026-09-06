---
name: WhatsApp contact automation safety
description: Safety rules for selecting WhatsApp contacts and sending configured messages through native Android UI automation.
---

The WhatsApp automation must discover the Send message FAB (`fabText`), contact rows (`contactpicker_row_name` Buttons), composer (`entry`), attachment option (`pickfiletype_document_holder`), and final media send (`send_media_btn`) from the current UI hierarchy before tapping. It must skip or stop when any expected target is missing, ambiguous, or stale, rather than falling back to guessed coordinates. Use an internal live-row key (label/content-desc plus bounds) for within-process deduplication; display names alone are not unique.

**Why:** WhatsApp accessibility labels and contact-picker layouts vary across app versions and devices; a guessed tap can message the wrong person.

**How to apply:** Re-dump the live hierarchy after every navigation step, ignore the New group/New contact/New community/Message yourself rows, keep contact selection distinct within a process, resolve spintax before the native long-press Paste action, and use Document for arbitrary staged attachments.

After tapping WhatsApp's Send message FAB, allow a bounded settle/poll window before judging the contact list empty. Log each poll's surface markers, contact-row count, usable-row count, and last successful control both in the Action Log response and the server debug log.

**Why:** The contact picker can still be transitioning after the FAB tap; a single early dump falsely reports zero contacts and hides whether navigation, rendering, or row filtering failed.

**How to apply:** Keep the wait finite, re-dump on each poll, and include enough live hierarchy summary to distinguish the home screen, picker shell, and populated contact list without falling back to guessed taps.

The WhatsApp composer path must verify both clipboard preparation and the resulting composer text. If Android exposes Autofill instead of Paste, poll the edit menu, record the visible menu labels without recording message contents, and allow only a guarded KEYCODE_PASTE fallback when the composer text is verified afterward.

**Why:** A long-press can open a valid text-editing menu while still failing to expose Paste; sending based only on the menu or clipboard command result risks sending an empty or wrong message.

**How to apply:** Treat clipboard readback as best-effort because some Android builds hide it, fingerprint the expected message rather than logging its contents, and fail closed unless native Paste or the explicit fallback visibly populates the live `entry` field.

On the Xiaomi Redmi A5 test device, `adb shell cmd clipboard set` can return without an ADB error while the subsequent clipboard probe is empty; Autofill then appears instead of Paste.

**Why:** Exit-code-only clipboard handling falsely treats the message as available and leaves the flow stuck at the edit menu.

**How to apply:** When readback reports a mismatch, dismiss the edit menu, refocus `entry`, type through the existing ADB text-input path, and verify the live composer text before allowing Send.