---
name: Mobile platform account slots
description: Cross-platform account-slot storage and execution rules for the Phone Farm.
---

Keep Instagram and Snapchat accounts in one ordered device slot list, using a per-slot platform marker to choose the app launched for a cycle. Snapchat Step 2 is Add Friends, Accept Friends, Reply to Unread Chats, and View Snaps; Copy Settings must target only slots of the source platform.

**Why:** The Human Session Tool timer and device collision coordinator already key off the device's account slots, so scheduling stays shared. The user requires Snapchat tools and labels to remain separate from Instagram automation and Settings > TrustScores, and requested same-platform copy only.

**How to apply:** Extend the platform discriminator and app-launch branch, but keep Snapchat settings, copy targets, and dispatch platform-specific. Store the display label on that Snapchat account slot only; never resolve it through TrustScore APIs, templates, timers, or automation settings. Do not split shared HST scheduling or collision queues into platform-specific collections.

Snapchat HST cycles also need a Step 3: dismiss Snapchat from the floating-window/recents view with the swipe gesture saved in My Device, then return Home and lock the phone. Resolve swipe direction using the same device preference/model rules as Instagram.

**Why:** The user explicitly requested the same close-and-lock lifecycle for Snapchat while using the selected device gesture.

**How to apply:** Run this cleanup after Snapchat tools complete, including when a tool errors, but skip stale device input after a cycle abort.

View Snaps means Snapchat Spotlight, not Stories: tap the bottom-right Spotlight tab, treat Count as the number of vertical swipes, wait the configured seconds on each media before the next swipe, and roll a separate per-media Like % for its heart. Use the saved My Device swipe gesture for feed scrolling.

**Why:** The user specified Spotlight navigation, swipe-count semantics, per-view like probability, dwell time, and use of the calibrated device gesture.

**How to apply:** Keep these controls and execution Snapchat-only; fail closed if Spotlight or the configured swipe profile cannot be confirmed.

Snapchat Add Friends and Accept Friends open through the live top-right person-plus control. Add Friends acts only on Add buttons under Find Friends; Accept Friends expands optional View More batches and accepts only labeled Accept badges under Added Me. Before tapping the icon, detect any banner-sized clickable hitbox geometrically covering its tap point; allow only a short bounded recheck, never wait for chats to clear or tap through an overlay. If another activated tool follows either list tool, tap the top-left dismiss chevron and confirm the camera screen before continuing. Mass Snap currently has only a Snapchat Step 2 configuration scaffold modeled on SMS Select count and Swipe (px); do not send or select recipients until the user asks to build that behavior.

**Why:** The user supplied device inspection dumps and clarified that top banners can contain any content, so they must be detected by occlusion rather than message text. They want safe friend-list targeting without waiting for every chat notification to clear.

**How to apply:** Confirm the page, section, and exact labeled action from live UI nodes before tapping. Stop the dispatcher if a list cannot be safely collapsed. Preserve Mass Snap settings independently from SMS and Instagram.

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
