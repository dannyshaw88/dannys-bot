---
name: Mobile platform account slots
description: Cross-platform account-slot storage and execution rules for the Phone Farm.
---

Keep Instagram and Snapchat accounts in one ordered device slot list, using a per-slot platform marker to choose the app launched for a cycle. Snapchat Step 2 is Add Friends, Accept Friends, Reply to Unread Chats, and View Snaps; Copy Settings must target only slots of the source platform.

**Why:** The Human Session Tool timer and device collision coordinator already key off the device's account slots, so scheduling stays shared. The user requires Snapchat tools and labels to remain separate from Instagram automation and Settings > TrustScores, and requested same-platform copy only.

**How to apply:** Extend the platform discriminator and app-launch branch, but keep Snapchat settings, copy targets, and dispatch platform-specific. Store the display label on that Snapchat account slot only; never resolve it through TrustScore APIs, templates, timers, or automation settings. Do not split shared HST scheduling or collision queues into platform-specific collections.

For Snapchat unread-chat replies, use the OpenAI key managed in Settings > Security and send only the user's goal plus bounded visible thread context to the model. Treat chat text as untrusted, never log credentials, and do not send unless the thread and composer are still verified.

**Why:** The user wants replies to follow a conversation goal and timing instructions, while keeping Snapchat behavior independent from Instagram.

**How to apply:** Fail closed when the key, readable context, generated reply, or live-thread confirmation is missing; make clear in the UI that visible chat content is sent to OpenAI.

Snapchat tool activation chances and shuffle order belong inside `snapchatTools`, not Instagram's shared settings. Roll each enabled tool once per cycle, then Fisher–Yates shuffle only the activated tools when Snapchat shuffle is on. Default activation ranges to 100/100 and shuffle to off for existing slots.

**Why:** The user wants Snapchat tools to stop running on every cycle without changing Instagram's behavior.

**How to apply:** Keep the controls and saved values Snapchat-specific, and normalize nested settings on load so older slots receive the defaults.

Per-device Instagram/Snapchat tab order and last-selected landing tab must survive app restarts and remain isolated by device serial.

**Why:** The user wants each Farm device to reopen on its chosen platform tab with its preferred tab order.

**How to apply:** Persist tab preferences as device-level configuration, separate from account-slot records, and hydrate them when that device is opened.

The frontend HST slot-index guard must match the API's 1,000-slot limit; otherwise appended Snapchat slots can display a toggle but silently skip persistence and scheduling.

**Why:** The user added Snapchat account slots alongside existing Instagram slots, and an HST cap of ten made later slots appear usable while preventing their cycles from starting.

**How to apply:** Keep all frontend slot-index validation aligned with the API's account-slot range.
