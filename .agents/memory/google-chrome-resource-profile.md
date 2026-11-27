---
name: Standalone Chrome resource profile
description: Resource policy for the standalone Google Chrome browser used with Facebook.
---

The standalone Google Chrome browser is one interactive session, not a pool of concurrent account browsers. It should use Chrome's normal renderer count, JavaScript heap, cache, and background networking; keep the memory-saving limits on the many-account Instagram browser sessions.

**Why:** Facebook's JavaScript-heavy pages and Messenger UI were running under limits chosen to make many isolated sessions fit in memory. That standalone browser does not need those same constraints.

**How to apply:** When adjusting browser launch flags, preserve this per-profile distinction. Do not infer that the resource-policy change alone proves every Facebook rendering delay is solved; verify on the actual Windows browser.
