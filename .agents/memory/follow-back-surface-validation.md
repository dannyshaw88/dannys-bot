---
name: Follow Back surface validation
description: Instagram may keep a search field visible over a profile after a calibrated Back
---

After a Follow profile Back tap, a visible search field does not prove the app is on Search Results. Instagram can render the account profile layout with the search field still at the top; inspect profile-only markers before sending search key events, and issue the missing calibrated Back when needed.

**Why:** A rejected candidate run sent clear-search key events while the account profile was still visible, which damaged the UI instead of returning to Explore.

**How to apply:** In Follow cleanup, validate the live surface after the first calibrated Back. Treat profile-header/grid/edit-profile markers as an unexpected profile state, use the second calibrated Back, then tap and confirm the Explore search field before typing.