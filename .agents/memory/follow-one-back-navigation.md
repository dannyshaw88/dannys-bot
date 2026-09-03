---
name: Follow one-back navigation
description: Back-stack rule for the Human Session Tool Follow Users flow
---

After opening a user from Instagram search results, exactly one calibrated
Instagram Back tap (`settingsBack`, the mirror-calibrated arrow) returns from
the profile to the search-results/Explore context. The absence of the Home tab
on that screen is expected and must not trigger another Back.

**Why:** The visible Instagram arrow is the reliable profile-exit control on
this device flow. A second navigation action exits the search context and
lands on Instagram's Home feed, so the next target cannot reliably find the
search bar.

**How to apply:** Keep profile-exit cleanup to one calibrated Back tap. Use
Android Back only for transient post viewers, sheets, or other surfaces that
were opened from the profile. Do not use Home-tab presence as a reason to tap
Back again; search-bar recovery should operate from the search-results
context instead.