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

The WhatsApp composer path must tap the live `entry` field and use direct ADB text input, then verify the resulting composer text. It must not open the long-press edit menu or attempt clipboard preparation first.

**Why:** On the Xiaomi Redmi A5, the long-press path opens Autofill instead of Paste and can waste roughly 20 seconds before the actual direct-entry fallback.

**How to apply:** Focus `entry`, call the bulk input path once, wait only for the keyboard/input update, and fail closed unless the live field contains the intended message. Keep clipboard helpers isolated from this flow.

Image attachments must use WhatsApp's `pickfiletype_gallery_holder`, not the Document picker. Stage them in DCIM/Camera and identify the staged Gallery thumbnail from its MediaStore-indexed timestamp; never assume the first visible thumbnail is the uploaded source.

**Why:** DocumentsUI can show the staged file in Recents without selecting it, while Gallery is the same media-import path used by Make a Post and its thumbnails do not expose source filenames. WhatsApp's displayed date follows the media taken/EXIF timestamp, not necessarily the scan time.

**How to apply:** Scan the staged DCIM file, query `date_taken` before falling back to scan timestamps, treat numeric `"0"`/negative values as unavailable, allow phone/host timezone offsets while retaining minute-level matching, tap only that match, and require `send_media_counter=1` before sending. Keep non-image attachments on the Document path.

WhatsApp Add Media is a raw-transfer path, not Make a Post processing: do not strip metadata, run AI-slop repair, alter pixels, or apply any other Make a Post transformation.

**Why:** The selected attachment should be sent as the user supplied it; Make a Post's cleanup pipeline is intentionally unrelated to WhatsApp messaging.

**How to apply:** Decode the selected data URL, transfer those bytes to the phone, scan/index the copy, and use only the picker/import verification needed to attach it. At the end of the run, close WhatsApp through the same configured floating-window recents gesture used by HST; do not add an airplane-mode cycle to WhatsApp.