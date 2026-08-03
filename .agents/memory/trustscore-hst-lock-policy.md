---
name: TrustScore HST lock policy
description: Rules for keeping inherited Human Session Tool settings disabled while preserving slot-level controls.
---

TrustScore-assigned Phone Farm slots must use explicit field-level disable rules for every HST control. The generic loading state is not a substitute because it cannot distinguish inherited template settings from editable slot controls. Follow Users operation counts, spread behavior, Inject Browsing details, and unrelated Make a Post settings are template-controlled; the Inject Browsing master, Follow Filters master and each individual filter, Follow Sources, and Make a Post alteration/image/caption-quality controls are slot-owned.

**Why:** The HST form contains many controls that historically used the generic loading flag, which allowed inherited settings to appear editable after TrustScore resolution or accidentally disabled intended slot controls.

**How to apply:** Keep the existing slot-level editing policy for assigned slots, but restrict Human Session Tool Copy Settings to exactly Follow Sources, Random Actions profile-picture directory, Random Actions Bio spin text, Make a Post Instagram Account source, and Make a Post My Computer source plus assigned directory. Grey out every other Copy Settings row regardless of tool toggle state, and enforce the same allow-list in the API. Keep Copy Settings visible independently of the current device's username count; its dialog should determine whether valid targets exist.

Existing Phone Farm accounts also need a one-time identity bridge: match each saved slot username/account label to the profile's TrustScore badge and create the device/slot assignment only when that slot has never been explicitly configured. Never replace the slot's saved automation object during this migration. HikerAPI is template-controlled, not slot-owned.

**Why:** TrustScore badges predate the device/slot assignment store, so legacy accounts can have both a saved manual HST baseline and a profile badge without any assignment for the resolver to find.

**How to apply:** Run the bridge after loading Account Settings and refresh affected slot HST panels. Treat `configured: true, scoreId: null` as an intentional manual-mode clear, and preserve any existing server assignment as authoritative.