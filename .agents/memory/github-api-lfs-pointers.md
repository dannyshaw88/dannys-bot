---
name: GitHub API commits and LFS objects
description: GitHub REST Git-data commits do not upload Git LFS payloads when a pointer file is written as a normal blob.
---

Never publish an LFS-tracked file by creating only its pointer blob through the GitHub REST Git-data API; the referenced LFS object must also exist in GitHub LFS storage, or Windows clones fail with a 404 smudge error.

**Why:** Recreating local commits through the REST Git-data API preserved pointer files but did not transfer their LFS payloads, leaving a clean Linux checkout but breaking a Windows pull.

**How to apply:** For API-created commits, upload LFS objects through an authenticated LFS flow, or keep the file as a regular Git blob with an explicit non-LFS attribute exception when the payload is small enough and already available in Git history.