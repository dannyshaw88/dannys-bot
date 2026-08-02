---
name: Git remote history and runtime-state cleanup
description: Safe release pushes when the remote has an unrelated history containing local runtime artifacts
---

When a repository remote has an unrelated or divergent history, preserve the remote history with an explicit merge rather than force-pushing. Before pushing the merged tip, remove tracked runtime state such as cookies, browser sessions, databases, device state, downloaded ADB tooling, generated preview files, and local uploads; add durable ignore rules so those files cannot return.

**Why:** Existing remote branches may contain valuable source history but also accidental private machine state. A force-push can erase collaborators' history, while a blind merge can publish credentials or runtime artifacts.

**How to apply:** Create a local recovery branch, fetch the remote, merge with explicit intent, audit the resulting tracked tree—including newly uploaded files under `attached_assets/`—commit cleanup separately, and push only after verifying the remote tip matches the local commit.