---
name: Follow one-back navigation
description: Back-stack rule for the Human Session Tool Follow Users flow
---

After opening a user from Instagram search results, exactly one Android Back
returns from the profile to the search-results/Explore context. The absence of
the Home tab on that screen is expected and must not trigger another Back.

**Why:** A second Back exits the search context and lands on Instagram's Home
feed, so the next target cannot reliably find the search bar.

**How to apply:** Keep post-follow cleanup to one Back. Do not use Home-tab
presence as a reason to press Back again; search-bar recovery should operate
from the search-results context instead.