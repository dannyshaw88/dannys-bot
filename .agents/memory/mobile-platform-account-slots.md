---
name: Mobile platform account slots
description: Cross-platform account-slot storage and execution rules for the Phone Farm.
---

Keep Instagram and Snapchat accounts in one ordered device slot list, using a per-slot platform marker to choose the app launched for a cycle. Snapchat Step 2 is Add Friends, Accept Friends, Reply to Unread Chats, and View Snaps; Copy Settings must target only slots of the source platform.

Reply to Unread Chats must tap and validate only Snapchat's “Unread” chat-list filter; never use “Unreplied.”

After launching Snapchat, wait five seconds before starting its first tool so the app can finish loading its Chat screen.

After tapping the Snapchat Chat tab for Reply to Unread Chats, wait fifteen seconds before looking for the Unread filter.

The user wants five individual accounts on each device. Keep their settings, prompts, contacts, and reply history isolated by persisted slot identity.

**Why:** the user explicitly wants five independent accounts on every device.

**Why:** The Human Session Tool timer and device collision coordinator already key off the device's account slots, so scheduling stays shared. The user requires Snapchat tools and labels to remain separate from Instagram automation and Settings > TrustScores, and requested same-platform copy only.

**How to apply:** Extend the platform discriminator and app-launch branch, but keep Snapchat settings, copy targets, and dispatch platform-specific. Store the display label on that Snapchat account slot only; never resolve it through TrustScore APIs, templates, timers, or automation settings. Do not split shared HST scheduling or collision queues into platform-specific collections.

In Snapchat Copy Settings, keep Reply to Unread Chats' prompt as an opt-in child setting, separate from the tool controls. If the prompt option is off, copying the tool must preserve each target slot's existing prompt.

**Why:** The user does not always want reply prompts copied along with the operational settings.

**How to apply:** Omit `replyGoal` from the copied tool payload unless the child checkbox is selected; the API merges the partial tool object over the target's saved values.

Snapchat HST cycles also need a Step 3: dismiss Snapchat from the floating-window/recents view with the swipe gesture saved in My Device, then return Home and lock the phone. Resolve swipe direction using the same device preference/model rules as Instagram.

**Why:** The user explicitly requested the same close-and-lock lifecycle for Snapchat while using the selected device gesture.

**How to apply:** Run this cleanup after Snapchat tools complete, including when a tool errors, but skip stale device input after a cycle abort.

Snapchat swipe input must use the device's saved Swipe Gesture profile only; do not apply Mother Code swipe modifiers, per-device swipe-personality overrides, or account-slot personality scaling to any Snapchat account.

**Why:** The user explicitly requested that Snapchat accounts follow the saved Swipe Gesture profile instead of device or slot swipe-personality overrides.

**How to apply:** Keep Snapchat swipe resolution platform-specific and use the saved gesture's coordinates, duration range, jitter, pause, and settle values without Mother Code or slot scaling.

Keep Snapchat's two viewers distinct: View Spotlights uses the Spotlight tab, counts vertical swipes, waits on each item, and may like with its own Like %; View Snaps opens a circular Story, counts the initial Snap plus each successful right-side advance, and waits only between advances. View Snaps has no Like control.

**Why:** The user explicitly separated Spotlight browsing from Stories and defined Snap-count and right-side-tap behavior.

**How to apply:** Keep both Snapchat-only with independent activation/settings; fail closed unless the Stories list, circular Story, and Story viewer are confirmed. View Spotlights retains the configured My Device swipe gesture and Like controls.

Snapchat Add Friends and Accept Friends open through the live top-right person-plus control. Add Friends acts only on Add buttons under Find Friends; Accept Friends expands optional View More batches and accepts only labeled Accept badges under Added Me. For the person-plus, each Add/Accept button, View More, and collapse chevron, keep checking the latest live UI until no banner covers the target, then tap immediately from that same UI snapshot. After every Add Friends or Accept Friends tool flow—including the last or shuffled tool—tap the down-chevron and verify return to Camera. Space confirmed Accept actions by a random 1–3 seconds, rechecking the live list between actions. Mass Snap currently has only a Snapchat Step 2 configuration scaffold modeled on SMS Select count and Swipe (px); do not send or select recipients until the user asks to build that behavior.

**Why:** The user explicitly corrected the earlier behavior: a banner or transient screen must cause retries, not a skipped tool; the clear-screen check and tap must be immediate, and every Add/Accept flow must close with its down-chevron.

**How to apply:** Confirm the page, section, and exact labeled action from the latest live UI. For Find Friends Add taps, refresh the hierarchy immediately before tapping, send the exact node center without tap jitter, and recover/retry if the tap leaves the Add Friends screen; do not require the Add label to change. Poll quickly and abortably while blocked, rate-limit wait logs, verify the chevron returns to Camera after each tool, and stop the dispatcher if the panel cannot be safely collapsed. Preserve Mass Snap settings independently from SMS and Instagram.

For Snapchat unread-chat replies, use OpenAI GPT-6 Luna with reasoning effort set to none and a bounded output-token limit. Read the OpenAI key from Settings > Security and send only the user's goal plus bounded visible thread context. Treat chat text as untrusted, never log credentials, and do not send unless the thread and composer are still verified.

**Why:** The user chose GPT-6 Luna as the low-cost reply model and wants goal-aware replies without coupling Snapchat to Instagram.

**How to apply:** Fail closed when the key, readable context, generated reply, or live-thread confirmation is missing; make clear in the UI that visible chat content is sent to OpenAI. Recheck API parameter support before switching models.

Snapchat tool activation chances and shuffle order belong inside `snapchatTools`, not Instagram's shared settings. Roll each enabled tool once per cycle, then Fisher–Yates shuffle only the activated tools when Snapchat shuffle is on. Default activation ranges to 100/100 and shuffle to off for existing slots.

**Why:** The user wants Snapchat tools to stop running on every cycle without changing Instagram's behavior.

**How to apply:** Keep the controls and saved values Snapchat-specific, and normalize nested settings on load so older slots receive the defaults.

Per-device Instagram/Snapchat tab order and last-selected landing tab must survive app restarts and remain isolated by device serial.

**Why:** The user wants each Farm device to reopen on its chosen platform tab with its preferred tab order.

**How to apply:** Persist tab preferences as device-level configuration, separate from account-slot records, and hydrate them when that device is opened.

The frontend HST slot-index guard must match the API's 1,000-slot limit; otherwise appended Snapchat slots can display a toggle but silently skip persistence and scheduling.

**Why:** The user added Snapchat account slots alongside existing Instagram slots, and an HST cap of ten made later slots appear usable while preventing their cycles from starting.

**How to apply:** Keep all frontend slot-index validation aligned with the API's account-slot range.
