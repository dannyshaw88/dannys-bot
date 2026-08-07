---
name: Standalone Post a Story settings
description: Durable ownership and execution rules for the separate Human Session Tool Story publisher.
---

The standalone Post a Story tool keeps behavioral settings (activation range, folder options, alteration, image filters, Fix AI Slop, and uniquification) in Trust Score templates and Copy Settings, but its local media directory is always owned by the physical device/account slot.

**Why:** Each slot may need a different local media source, while behavioral automation should stay consistent across accounts assigned to the same Trust Score.

**How to apply:** Keep the Story directory out of behavioral copy operations and Trust Score template values. Persist it through a slot-specific store/endpoint and hydrate it after resolving Trust Score settings. Execute Story as its own shuffled Step 2 tool rather than restoring Story destinations to Make a Post.