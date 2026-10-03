---
name: Mobile tap trace diagnostics
description: Logging standard for attributing mobile taps from intent through ADB dispatch.
---

Each mobile tap log must be independently attributable in the plain message text, not only structured fields: include a tap ID, requested and actual coordinates, jitter, exact/jittered mode, operator/automation origin, caller, and action reason. Repeat the tap ID on ADB begin/end/failure logs and include the trace metadata in optional session-recorder events. Operation-specific taps, especially View Reels actions, should name the action and reel context.

**Why:** the user emphasized that logs must show exactly what was pressed and why. Text exports may discard structured logger fields, and generic tap messages cannot identify which control opened an overlay. The legacy `source: "manual"` value means exact/no-jitter behavior in some automated flows, not necessarily a human operator, so input mode and actor origin must remain separate.

**How to apply:** Route manual and automated taps through the shared trace path; explicitly set automation origin for exact taps issued by automation. Add action-specific reasons to high-impact operation paths. If an older trace lacks target, caller, or reason, treat any attribution as a hypothesis rather than recovered fact.