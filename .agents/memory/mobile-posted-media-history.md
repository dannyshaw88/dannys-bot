---
name: Mobile account posted-media history
description: Account-specific profile-post history must remain separate from the device-wide no-repeat image cache
---

The Mobile Human Session Tool’s Posted Media history and Statistics Posts count must use a persistent record keyed by device, slot, and Instagram username, written only after confirmed profile-feed posting succeeds. Stories and merely selected/uploaded images must not count.

**Why:** The existing device-wide no-repeat list also contains Story uploads and serves a different purpose. Reusing it would mix accounts and destinations, making the Posted Media tab and Statistics counts inaccurate.

**How to apply:** Keep the no-repeat cache unchanged for source-image selection. Use the account-scoped profile-post history for the Mobile Posted Media tab and the Statistics Posts column, filtering by the selected slot/account.