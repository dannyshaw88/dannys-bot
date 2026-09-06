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