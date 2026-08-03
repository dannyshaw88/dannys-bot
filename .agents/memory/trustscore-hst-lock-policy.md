---
name: TrustScore HST lock policy
description: Rules for keeping inherited Human Session Tool settings disabled while preserving slot-level controls.
---

TrustScore-assigned Phone Farm slots must use explicit field-level disable rules for every HST control. The generic loading state is not a substitute because it cannot distinguish inherited template settings from editable slot controls. Follow Users operation counts, spread behavior, Inject Browsing details, and individual follower filters are template-controlled; the Inject Browsing master, Follow Filters master, and Follow Sources are slot-owned.

**Why:** The HST form contains many controls that historically used the generic loading flag, which allowed inherited settings to appear editable after TrustScore resolution or accidentally disabled intended slot controls.

**How to apply:** Keep only the master toggle, individual tool toggles, Inject Browsing master, Follow Filters master, and explicitly slot-owned source/data controls editable on assigned slots. Keep Follow Sources editable, but lock Follow Users counts, spread, Inject Browsing details, and individual filters. In Copy Settings, enable only those account-specific fields; grey out inherited percentages, filters, and behavior settings, and enforce the same allow-list in the API. Keep Copy Settings visible independently of the current device's username count; its dialog should determine whether valid targets exist.