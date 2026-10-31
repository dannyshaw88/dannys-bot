---
name: Snapchat Luna reply typing
description: How AI-generated Snapchat chat replies must be entered and verified.
---

Reply to Unread Chats must enter Luna's reply through the device's saved mirror keyboard calibration map, not clipboard or paste. Tapping a chat row focuses its composer; do not tap inside the text field again before typing. If a character has no saved key position, skip that character and continue typing the mapped characters. Verify the text actually entered in the composer and send that entered text, not the original draft. Open Chat once, then wait up to 30 seconds for the Unread tab, checking every 5 seconds and tapping it as soon as it appears. After a reply, press Android Back twice to leave the chat; retain the existing Unread list without tapping Chat again.

**Why:** The user said clipboard paste does not work and explicitly requires Luna's response to be typed with calibrated keys. They clarified that opening a chat focuses the composer, so an extra field tap is unnecessary. They also specified skipping missing keys, waiting for the delayed Unread tab instead of double-tapping Chat, and refreshing Chat only between replies when another one will be sent. They run live phone behavior in Windows Electron; Replit is for prompt tests only.

**How to apply:** Keep other typing callers strict by default. Put Luna conversation wording and behavior constraints in the user's editable reply prompt, not fixed generator rules, unless the user explicitly asks for hard-coded enforcement. Use the Replit-only Luna sandbox for prompt tests; diagnose live phone behavior from Windows Electron logs. Never infer the active Windows Electron prompt or live-device result from Replit's synthetic slot/settings, and never claim Replit can trace the user's phone. For live Snapchat replies, type directly after opening the chat without an extra composer tap, skip only unavailable characters, continue the calibrated sequence, verify and record/send the actual composer contents, and use two Android Back key events after exiting each chat.

## Batched calibrated reply typing
When `batchTaps` is enabled, execute consecutive calibrated key taps in one ADB shell command. Keep keyboard-layer controls as separate commands and preserve the configured pauses inside the batch.

**Why:** The Snapchat caller already requested batched taps, but the saved-calibration typer did not implement that option; a separate ADB process per character adds transport overhead.

**How to apply:** Keep batching limited to the Snapchat reply path until verified on a physical device. Measure device-input queue wait separately from ADB command time.

**Debugging log:** For live Snapchat replies, show the full Luna draft before typing and log concise action outcomes; suppress per-character progress lines.

**Why:** The user wants to inspect Luna's intended sentence while keeping the live log readable and focused on what the tool did.

**How to apply:** Keep detailed calibration diagnostics out of the Snapchat action log; retain actionable failures and the draft, typing, send, and completion results.

**Snapchat contact identity:** Read and retain the contact name from the unread-list row before tapping that same name to open the conversation. Do not inspect or validate the conversation header; require the chat composer before drafting.

**Why:** The user says the header can be obscured by banners and should not gate replies. The name on the unread list is visible before opening and is the intended contact identity.

**How to apply:** Capture the row name from one unread-list snapshot, then tap horizontally in the row's central text area at the name's vertical position, between the avatar and right-side action icon. Do not tap the avatar, action icon, or conversation header. Use the captured name for prompt context and reply history; after opening, check for a composer only.

**Snapchat panel navigation:** Close the Add Friends panel with one Android Back press after Add Friends or Accept Friends finishes. Do not tap the down-chevron or run a banner-clear check for this navigation.

**Why:** The user confirmed Android system Back is safe for leaving this panel and does not require banner checks.

**How to apply:** Keep banner checks for Add/Accept action buttons themselves, but use one system Back press to close the completed tool's panel.

**Prompt source of truth:** Keep all conversational timing, reply wording, link timing, and redirect rules in the user's editable reply goal. Do not hardcode prompt-specific text, phrase checks, or fallback replies in software.

**Why:** The user explicitly requires the editable prompt to be the sole source of truth for prompts and replies; hardcoded wording can conflict with their saved instructions.

**How to apply:** Edit the saved prompt for conversational behavior. Keep only generic automation concerns in code, such as calibrated typing and confirmation that text was entered and sent; do not enforce wording, link timing, or semantic phrases in the sender.

**Link reply content:** The prompt's Boundlus message should answer the latest message, explain that Luna is getting overwhelmed on Snap, and directly invite the person to add her so they can talk more privately on Boundlus.

**Why:** The user said “Catch me on Boundlus” without a contextual response or reason to switch feels weak.

**How to apply:** Keep that sequence, rationale, direct invitation, and exact URL in the editable prompt, within its supporting-word limit. Do not duplicate these requirements as code checks or canned messages.

**Post-link clarification:** After sending the Boundlus link, allow one answer only to a clear question about what Boundlus is or what the link means. An unrelated message such as “I just tried too” is not a question and must get no reply.

**Why:** The user reports contacts ask what Boundlus is after receiving the link and wants a single explanation before ending the conversation.

**How to apply:** Keep this exception and its exact explanation in the editable prompt: “It’s a new social media app people are making easy money off, so I’m using that more.” For every other post-link message, return SKIP; after the one explanation, stop completely. Do not resend the link, quote the incoming message, or add a code-level reply rule.

**Unread list eligibility:** Treat the Snapchat Unread tab itself as the unread signal; do not require a row status to say “New Chat.” Reply to named text-chat rows there even when the status says “Received” or “Opened.” Ignore pure Snap/photo/video rows, but allow a mixed media-and-chat row only through its separate chat-only right-side action icon.

**Why:** The run stopped after two replies because the row filter accepted only “New Chat” labels, although other text-chat rows remained in the Unread tab with statuses such as “Received” or “Opened.” The user also identified red photo and purple video reply icons as media replies and instructed the automation not to open them. A mixed “Snaps and Chats” row can expose a separate action icon that opens the chat without opening media.

**How to apply:** Verify the Unread tab is active, then select named rows from it regardless of status wording. Filter media-only rows out regardless of icon color. For mixed rows, require the confirmed chat-only action icon and tap that icon instead of the row body.

**Unread reply count:** Reply to Unread Chats has no fixed upper cap; its configured Max is only the upper end of the user's selected count range.

**Why:** The user explicitly said there should be no maximum number of unread chats to reply to.

**How to apply:** Keep the UI, API validation, and run-count selection uncapped for this tool. The run still ends when it reaches the selected count or Snapchat has no more eligible unread chats.
