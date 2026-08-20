---
name: Sharp Windows access violations
description: Native Sharp/libvips concurrency can terminate the packaged API during sustained mobile screenshot activity
---

On Windows, a packaged API access violation (`0xC0000005`) can occur while mobile screenshot polling is heavy and screenshot-based visual detection is decoding PNGs. Treat both Sharp/libvips native concurrency and synchronous full-resolution pixel scans as crash-risk boundaries.

**Why:** Confirmed API child crashes occurred with `apiExitCode=3221225477` after sustained screencap traffic; one diagnostic also showed a 20.6-second Node event-loop stall immediately before a screencap request failed.

**How to apply:** Keep Sharp concurrency at one, disable its native cache, serialize visual screenshot decodes, and bound/yield any synchronous screen-pixel search. Recheck every new visual detector for CPU cost and package the Electron bundle before testing.

Cache decoded visual reference templates instead of re-decoding the same JPG/SVG during every device lookup; repeated reference-image Sharp calls add native pressure without improving detection.

The Fix AI Slop path must remain binary-only while device automation is active; do not reintroduce a Sharp JPEG re-encode or child-process handoff there.

**Why:** A packaged API exited with `0xC0000005` 425 ms after the Fix AI Slop Sharp worker reported a clean exit, leaving the native handoff as the strongest actionable crash boundary.

**How to apply:** Strip metadata from the image bytes, write the cleaned bytes to the temporary output, and leave format conversion to a separately validated pipeline if it is ever required.