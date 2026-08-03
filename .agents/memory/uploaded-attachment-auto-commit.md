---
name: Uploaded attachment auto-commit
description: Uploaded files in attached_assets can be added by the workspace during a later Git push.
---

An uploaded attachment can be automatically committed by the workspace during a later push, even when it was previously left untracked and was not manually staged.

**Why:** A push of an application fix advanced the remote with a separate automatic asset commit containing the uploaded screenshot.

**How to apply:** Recheck the final remote commit and tree after every push; do not assume an intentionally untracked attachment remained out of Git.