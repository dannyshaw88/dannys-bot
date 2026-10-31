---
name: Snapchat Add Friends confirmation
description: Treat the Add tap as the completed action without waiting for Snapchat's button label to change.
---

After tapping Add for a matched Find Friends row, count the action and continue without requiring Snapchat to replace the Add label or show a confirmation. Remember attempted rows for the current run so a stale row is not tapped twice.

**Why:** The user reports the Add action works, but Snapchat's delayed or unchanged confirmation UI was stopping the tool and cycle.

**How to apply:** Keep confirmation-independent continuation scoped to Add Friends; preserve the live row-to-button match used to select the intended friend.
