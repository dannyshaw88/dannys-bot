---
name: View Feed visual reference packaging
description: The View Feed Like matcher depends on a real decodable heart PNG in both dev and Electron asset roots.
---

View Feed must use the visual Like reference as its sole Like anchor; accessibility nodes may only help identify optional neighboring controls. The Electron build must copy the canonical PNG rather than embed an unvalidated Base64 placeholder.

**Why:** A stale embedded blob was corrupt, while the local placeholder had no heart shape. The resulting fallback path allowed an ad/media coordinate to be mistaken for the Like target.

**How to apply:** When rebuilding the Windows app, verify the packaged `like-icon-refs/like-reference-reels.png` decodes and contains visible contrast before distributing the installer.