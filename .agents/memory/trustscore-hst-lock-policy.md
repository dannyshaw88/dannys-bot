---
name: TrustScore HST lock policy
description: Rules for keeping inherited Human Session Tool settings disabled while preserving slot-level controls.
---

TrustScore-assigned Phone Farm slots must use explicit field-level disable rules for every HST control. The generic loading state is not a substitute because it cannot distinguish inherited template settings from editable slot controls. Follow Users operation counts, spread behavior, the filter master, and every follower filter are template-controlled; only Follow Sources is slot-owned.

**Why:** The HST form contains many controls that historically used the generic loading flag, which allowed inherited settings to appear editable after TrustScore resolution or accidentally disabled intended slot controls.

**How to apply:** Keep only the master toggle, individual tool toggles, and explicitly slot-owned source/data controls editable on assigned slots. Keep Follow Sources editable, but lock Follow Users counts, spread, and all filters. Keep Copy Settings visible independently of the current device's username count; its dialog should determine whether valid targets exist.