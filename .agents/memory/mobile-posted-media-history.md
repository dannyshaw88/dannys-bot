---
name: Mobile account posted-media history
description: Account-specific profile-post history must remain separate from the device-wide no-repeat image cache
---

The Mobile Human Session Tool’s Posted Media history and Statistics Posts count must use a persistent record keyed by device, slot, and Instagram username, written only after confirmed profile-feed posting succeeds. Stories and merely selected/uploaded images must not count.

**Why:** The existing device-wide no-repeat list also contains Story uploads and serves a different purpose. Reusing it would mix accounts and destinations, making the Posted Media tab and Statistics counts inaccurate.

**How to apply:** Keep the no-repeat cache unchanged for source-image selection. Use the account-scoped profile-post history for the Mobile Posted Media tab and the Statistics Posts column, filtering by the selected slot/account.

Thumbnail previews for this history should be stored as server-managed derivatives, not exposed as direct PC-folder paths. Generate them from the prepared image only after the profile post is confirmed; older entries may be backfilled when the history is loaded.

**Why:** The UI needs durable previews after reloads, while PC source paths are local implementation details and may no longer exist.

**How to apply:** Keep thumbnail files under the posted-profile-media data area and serve them through an authenticated/validated serial + entry route; never make the original folder a browser asset root.