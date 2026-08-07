---
name: Mirror video/device aspect-ratio mismatch is letterbox, not stretch
description: Why a video-decode-size vs wm-size mismatch in the phone mirror causes tap accuracy that's fine in the center but drifts near the edges, and the correct rescale fix.
---

Android's screen capture (`screenrecord`, and virtual-display capture generally) never stretches the real screen non-uniformly to fill a differently-shaped recording buffer. It preserves the source aspect ratio and letterboxes/pillarboxes: real content is centered in the buffer at its own correct ratio, the rest of the buffer is dead black padding.

A naive tap rescale (`x / videoW * realW`, applied across the whole buffer) is only accurate at the exact center of the padded axis — it drifts increasingly off toward the padded edges. Symptom: "tap the middle of the screen = fine, tap near an edge = off," reported alongside a Check Screen Info showing wildly different `wm size` vs. decoded-video-frame numbers (e.g. device ~20:9 vs. video 16:9).

**Fix:** compute the real content sub-rectangle within the video buffer first (compare buffer AR to device `wm size` AR, fit the device's AR centered within the buffer — same math Android itself used to produce the frame), then rescale tap/swipe coordinates relative to that sub-rect, not the raw buffer. Reduces to a no-op when the ratios already match. Implemented server-side in `artifacts/api-server/src/routes/mobile.ts` (`videoContentRect`, used by `rescaleForDevice` and the swipe route).

**Not yet done:** the mirror's own on-screen rendering still shows Android's internal black padding baked into the video (not cropped out) — a cosmetic-only fix, deliberately deferred since it requires touching the render/mapToPhone pipeline (see `mobile-mirror-tap-rescale-ar-guard.md` and `mobile-mirror-shell-pillarbox.md` for how fragile that pipeline has been). If asked to also make the mirror visually crop out the padding, that's a separate task requiring the client to know the device's real `wm size` (currently only the server knows it, fetched fresh per tap).
