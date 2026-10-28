---
name: Mobile platform account slots
description: Cross-platform account-slot storage and execution rules for the Phone Farm.
---

Keep Instagram and Snapchat accounts in one ordered device slot list, using a per-slot platform marker to choose the app launched for a cycle. Treat a missing platform marker as Instagram.

**Why:** The Human Session Tool timer and the device collision coordinator already key off the device's account slots. A unified list preserves that shared scheduling and coordination model while keeping existing accounts on Instagram.

**How to apply:** When adding another mobile account platform, extend the platform discriminator and its app-launch branch. Do not split timers, collision queues, or slot-owned state into platform-specific collections.
