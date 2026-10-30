---
name: Snapchat Luna reply typing
description: How AI-generated Snapchat chat replies must be entered and verified.
---

Reply to Unread Chats must enter Luna's reply through the device's saved mirror keyboard calibration map, not clipboard or paste. Tap the composer once, then start typing immediately without an intermediate keyboard-open dump or check. If a character has no saved key position, skip that character and continue typing the mapped characters. Verify the text actually entered in the composer and send that entered text, not the original draft. Open Chat once, then wait up to 30 seconds for the Unread tab, checking every 5 seconds and tapping it as soon as it appears. After exiting a sent reply, tap the bottom Chat tab only when another unread reply is pending; poll the banner every 120 ms and tap immediately once clear, then use the same Unread-tab wait. Do not retap after the final reply or when stopping.

**Why:** The user said clipboard paste does not work and explicitly requires Luna's response to be typed with calibrated keys. They also specified immediate typing after the composer tap, skipping missing keys, waiting for the delayed Unread tab instead of double-tapping Chat, and refreshing Chat only between replies when another one will be sent. They want to test Luna prompt changes in Replit without rebuilding the Windows installer. They explicitly want Luna's wording, count, and link-timing rules changed in the prompt, not hard-coded into the reply generator.

**How to apply:** Keep other typing callers strict by default. Keep Luna conversation wording and turn rules prompt-driven unless the user explicitly asks for code enforcement. Provide a Replit-only Luna prompt sandbox for iterative conversation tests. For live Snapchat replies, skip only unavailable characters, continue the calibrated sequence, verify and record/send the actual composer contents, wait for Unread with the specified polling window, and banner-check before tapping Chat between consecutive replies.

**Debugging log:** For live Snapchat replies, show the full Luna draft before typing and keep the Debugging Log to meaningful actions and outcomes; suppress per-character progress lines.

**Why:** The user wants to inspect Luna's intended sentence while keeping the live log readable and focused on what the tool did.

**How to apply:** Keep detailed calibration diagnostics out of the Snapchat action log; retain actionable failures and the draft, typing, send, and completion results.
