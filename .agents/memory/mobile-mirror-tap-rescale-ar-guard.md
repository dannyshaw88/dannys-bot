---
name: Mirror tap rescale must not skip on aspect-ratio mismatch
description: screenrecord (the phone-mirror video source) never matches the device's wm-size aspect ratio by design — a video/device AR mismatch is normal, not a sign of an incompatible coordinate space.
---

The phone mirror's video source (`screenrecord`, in `artifacts/api-server/src/routes/mobile.ts`)
is deliberately never pinned to the device's exact `wm size` — most panel
resolutions aren't 16-pixel-aligned, so `screenrecord` self-selects its own
encoder-supported size. That size can legitimately have a **different aspect
ratio** than the panel (e.g. video 720×1280 vs. device 1080×2460 on one real
test device with no resolution override active).

A prior fix (since reverted) treated a video/device AR mismatch as proof that
`wm size` was reporting the wrong (physical-panel, not logical-input)
coordinate space, and skipped rescaling entirely above a 2% AR difference —
sending raw video-pixel coordinates straight to `adb shell input tap`. That
broke every manual mirror tap (taps landing near screen center regardless of
click position, "double the size" symptom).

**Why:** `wm size` (Override size if present, else Physical size) is the same
coordinate space every other tap in this codebase (built from uiautomator
bounds) already targets successfully — it is the correct rescale target
regardless of whether its aspect ratio matches the video's. AR mismatch is
expected for this feature, not a bug signal.

**How to apply:** `rescaleForDevice()` must always do independent per-axis
scaling (`x/videoW*realW`, `y/videoH*realH`) from video pixel space into
`wm size`'s space — never skip rescaling based on an AR check. If mirror taps
are reported as inaccurate again, verify the *video's reported dimensions* are
the ones actually driving the scaling math (client sends `videoW`/`videoH`
matching the WebCodecs-decoded frame) before suspecting the target space is
wrong.
