---
name: Your Story and DM contact resource ID
description: Distinguish a story-sharing shortcut from a real DM contact avatar.
---

`grid_view_pog_avatar_view` is reused by Your Story/Close Friends and real DM contact avatars. Before selecting a recipient, inspect the parent content description and reject the story-sharing shortcut.

**Why:** the shared resource ID alone can make a shortcut look like a contact and send the action to the wrong surface.

**How to apply:** require the correct ancestor/parent description from the live UI tree rather than relying on the avatar resource ID alone.