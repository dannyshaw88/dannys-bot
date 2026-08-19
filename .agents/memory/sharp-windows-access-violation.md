---
name: Sharp Windows access violations
description: Native Sharp/libvips concurrency can terminate the packaged API during sustained mobile screenshot activity
---

On Windows, a packaged API access violation (`0xC0000005`) can occur while mobile screenshot polling is heavy and screenshot-based visual detection is decoding PNGs. Treat Sharp/libvips native concurrency as a crash-risk boundary.

**Why:** A confirmed API child crash occurred with `apiExitCode=3221225477` after sustained multi-device screencap traffic; no JavaScript exception was emitted.

**How to apply:** Keep Sharp concurrency at one, disable its native cache, and serialize visual screenshot decodes. Recheck every new Sharp call added to mobile automation for native concurrency and package the Electron bundle before testing.