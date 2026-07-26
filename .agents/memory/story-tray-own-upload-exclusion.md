---
name: Story tray own-upload exclusion
description: Selection rule for Instagram home-feed story bubbles
---

Instagram’s home-feed story tray puts the signed-in user’s upload control first. Its label may be attached to a wrapper or omitted from the node carrying the resource ID and bounds, so label-only filtering can still select it.

**Why:** Selecting the first detected candidate opened the camera/add-to-story flow instead of viewing another account’s story.

**How to apply:** Parse live bounds, sort candidates left-to-right, collapse overlapping parent/child nodes, and remove the leftmost physical bubble before randomizing or attempting story opens.