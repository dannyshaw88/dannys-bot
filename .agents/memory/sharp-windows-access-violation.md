---
name: Sharp Windows access violations
description: Native Sharp/libvips concurrency can terminate the packaged API during sustained mobile screenshot activity
---

On Windows, a packaged API access violation (`0xC0000005`) can occur while mobile screenshot polling is heavy and screenshot-based visual detection is decoding PNGs. Treat both Sharp/libvips native concurrency and synchronous full-resolution pixel scans as crash-risk boundaries.

**Why:** Confirmed API child crashes occurred with `apiExitCode=3221225477` after sustained screencap traffic; one diagnostic also showed a 20.6-second Node event-loop stall immediately before a screencap request failed.

**How to apply:** Keep Sharp concurrency at one, disable its native cache, serialize visual screenshot decodes, and bound/yield any synchronous screen-pixel search. Recheck every new visual detector for CPU cost and package the Electron bundle before testing.

Cache decoded visual reference templates instead of re-decoding the same JPG/SVG during every device lookup; repeated reference-image Sharp calls add native pressure without improving detection.

Fix AI Slop must preserve its full cleaning contract: binary metadata stripping followed by JPEG re-encoding in an isolated Sharp worker.

**Why:** The re-encode removes the complete image metadata/encoding footprint the feature is intended to clean; removing it would silently weaken the feature even if it reduces native risk.

**How to apply:** Keep Sharp out of the long-running API process, run the JPEG conversion in the worker, propagate worker failures, and continue monitoring packaged Windows runs for native crashes.