---
name: Windows LFS pointer line endings
description: Prevent Windows installer clean-check failures caused by CRLF-normalized Git LFS pointer files
---

Git LFS pointer blobs in release commits must use LF line endings. A CRLF pointer can make a Windows checkout report the downloaded, unchanged LFS object as modified after a fast-forward.

**Why:** The installer build refuses dirty checkouts before it pulls or builds, and GitHub-written pointer content can differ from the LFS clean-filter output only by line endings.

**How to apply:** Normalize the pointer blob to LF before publishing release commits, then verify a Windows-style checkout reports clean status after fetching the release branch.