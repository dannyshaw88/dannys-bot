---
name: Mobile platform account slots
description: Cross-platform account-slot storage and execution rules for the Phone Farm.
---

Keep Instagram and Snapchat accounts in one ordered device slot list, using a per-slot platform marker to choose the app launched for a cycle. Keep each platform's automation settings and tool suite separate; Snapchat's TrustScore chip is a display-only label, never a tier assignment or timer.

**Why:** The Human Session Tool timer and device collision coordinator already key off the device's account slots, so scheduling stays shared. The user explicitly requires Snapchat tools to be separate from Instagram tools and says Snapchat TrustScore labels have no connection to Settings > TrustScores.

**How to apply:** Extend the platform discriminator and app-launch branch, but use platform-specific settings UI and tool dispatch. Skip Snapchat in TrustScore profile hydration, assignments, and timers; render only a static label. Do not split shared HST scheduling or collision queues into platform-specific collections.
