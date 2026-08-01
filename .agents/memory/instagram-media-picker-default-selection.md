---
name: Instagram media-picker default selection (real-device Make a Post)
description: Why the real-device (ADB/Mobile Farm) Make a Post flow's blind grid tap silently aborted every attempt
---

On the real-Android-device automation path (`androidManager.ts` / `mobile.ts`, the "Mobile Farm"
tab — distinct from the EB/Puppeteer web-automation path tracked in `make-a-post-log.md`),
Instagram's "New post" media grid auto-selects the most recent photo as the default (shown
large in the preview pane) the instant the picker opens — confirmed via a user screenshot of a
manual tap on a real device. No thumbnail tap is required at all when the target file is the
newest item in the gallery (which it always is here, since we just adb-pushed it).

The grid's first cell is Instagram's "open camera" shutter tile, not a photo thumbnail. A prior
fix added a blind coordinate tap (~17% width, ~22% height) intended to select the just-pushed
image, but that coordinate landed on the camera tile instead — so no image was ever explicitly
selected, "Next" never appeared, and the attempt silently aborted every time. This matched the
user's exact symptom: "the plus sign gets clicked but no image is selected."

**Why:** blind coordinate taps on a grid whose first cell is a non-photo control are inherently
fragile, and here they were also unnecessary — Instagram already does the selection for us.

**How to apply:** don't assume a media grid requires an explicit tap to select the newest item;
check the platform's actual default-selection behavior (via a manual-tap screenshot/video from
the user) before adding a coordinate-guess tap. If a future build ever needs a *different* file
than the newest one, use an accessibility-tree scan for the specific target — never a blind
percentage-based coordinate on this grid.
