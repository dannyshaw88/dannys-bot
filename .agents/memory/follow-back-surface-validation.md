---
name: Follow Back surface validation
description: Instagram may keep a search field visible over a profile after a calibrated Back
---

After a Follow profile Back tap, a visible search field does not prove the app is on Search Results. Instagram can render the account profile layout with the search field still at the top; inspect profile-only markers before sending search key events, and issue the missing calibrated Back when needed. The tap-to-focus must complete before clearing, and the clear helper must await every key-event command before the caller navigates again.

**Why:** A rejected candidate run sent KEYCODE_MOVE_END and the delete sweep before the saved search-bar tap completed. The inputs overlapped a profile surface and damaged the UI instead of returning to Explore.

**How to apply:** In Follow cleanup, validate the live surface after the first calibrated Back. Treat profile-header/grid/edit-profile markers as an unexpected profile state, use the second calibrated Back, then await the search-field tap, confirm focus, and only then clear or type.