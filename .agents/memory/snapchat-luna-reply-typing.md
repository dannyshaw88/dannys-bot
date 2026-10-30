---
name: Snapchat Luna reply typing
description: How AI-generated Snapchat chat replies must be entered and verified.
---

Reply to Unread Chats must enter Luna's reply through the device's saved mirror keyboard calibration map, not clipboard or paste. Tap the composer once, then start typing immediately without an intermediate keyboard-open dump or check. If a character has no saved key position, skip that character and continue typing the mapped characters. Verify the text actually entered in the composer and send that entered text, not the original draft. Open Chat once, then wait up to 30 seconds for the Unread tab, checking every 5 seconds and tapping it as soon as it appears. After exiting a sent reply, tap the bottom Chat tab only when another unread reply is pending; poll the banner every 120 ms and tap immediately once clear, then use the same Unread-tab wait. Do not retap after the final reply or when stopping.

**Why:** The user said clipboard paste does not work and explicitly requires Luna's response to be typed with calibrated keys. They also specified immediate typing after the composer tap, skipping missing keys, waiting for the delayed Unread tab instead of double-tapping Chat, and refreshing Chat only between replies when another one will be sent. They want prompt-only changes, use Replit for prompt tests, and use Windows Electron for live phone behavior.

**How to apply:** Keep other typing callers strict by default. Put Luna conversation wording and behavior constraints in the user's editable reply prompt, not fixed generator rules, unless the user explicitly asks for hard-coded enforcement. Use the Replit-only Luna sandbox for prompt tests; diagnose live phone behavior from Windows Electron logs and never claim Replit can trace the user's phone. For live Snapchat replies, skip only unavailable characters, continue the calibrated sequence, verify and record/send the actual composer contents, wait for Unread with the specified polling window, and banner-check before tapping Chat between consecutive replies.

**Debugging log:** For live Snapchat replies, show the full Luna draft before typing and keep the Debugging Log to meaningful actions and outcomes; suppress per-character progress lines.

**Why:** The user wants to inspect Luna's intended sentence while keeping the live log readable and focused on what the tool did.

**How to apply:** Keep detailed calibration diagnostics out of the Snapchat action log; retain actionable failures and the draft, typing, send, and completion results.

**Profile-return recovery:** After verifying a contact's Snapchat username, require the chat header to be visible again before reading history or drafting. Retry the verified profile dismissal briefly; if the chat still cannot be confirmed, recover to the Unread list and skip only that contact rather than terminating the whole batch.

**Why:** One delayed profile dismissal previously stopped the entire unread batch before that contact's history and third-reply link rule could be evaluated.

**How to apply:** Never draft or send without a confirmed peer and composer. A profile-return failure is recoverable at the batch level only after the app's return to the Unread list is itself verified.
