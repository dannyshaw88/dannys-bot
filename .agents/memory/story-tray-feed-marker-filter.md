---
name: Story tray feed-marker filter
description: Story tray accessibility scans must reject lower-feed author markers that contain story labels.
---

Story tray candidates must be restricted to Instagram's upper feed-header region. Feed post avatars can expose labels like "<username>'s story, 1 of 0, Seen." and must never be treated as tray bubbles.

**Why:** A real device exposed the signed-in user's lower-feed avatar as the only remaining story candidate after the own-profile bubble was removed, causing a coordinate tap in the feed where no story opened.

**How to apply:** Filter by live bounds before sorting/deduplicating and removing the first own-profile tray bubble; use a generous upper-screen boundary, not label matching alone.