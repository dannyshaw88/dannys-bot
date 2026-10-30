---
name: Snapchat Upload a Snap settings boundary
description: Keep the per-slot Upload a Snap configuration separate from its future execution flow.
---

The Upload a Snap settings in Snapchat Step 2 are configuration only until the user requests the send flow. Persist its chance range, amount range, assigned Windows media-directory path, and random-selection flag inside the selected account slot's Snapchat tool settings.

**Why:** The user explicitly requested only the settings UI for now and said the upload flow would be implemented later.

**How to apply:** Do not add dispatch or media-upload behavior while working on the settings. Use the existing Windows Electron directory picker and slot-scoped automation settings autosave for the folder path.
