---
name: Actions source validation
description: Avoiding false positives in GitHub Actions source checks
---

CI guards that reject a configuration must inspect executable assignments rather than searching raw source text. Comments and diagnostic strings may intentionally contain the old or forbidden setting name.

**Why:** The Windows installer workflow failed before packaging because a grep matched a comment documenting the historical `HF_HUB_DISABLE_XET=1` bug, even though the setting was no longer active.

**How to apply:** Anchor checks to language-specific assignment syntax, keep the guard close to the build step it protects, and test the exact shell command locally before pushing.