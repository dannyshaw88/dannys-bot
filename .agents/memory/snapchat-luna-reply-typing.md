---
name: Snapchat Luna reply typing
description: How AI-generated Snapchat chat replies must be entered and verified.
---

Reply to Unread Chats must enter Luna's reply through the device's saved mirror keyboard calibration map, not clipboard or paste. Tapping a chat row focuses its composer; do not tap inside the text field again before typing. Treat Snapchat's “Send a chat” and “Send chat” composer placeholders as empty, not as a pre-existing draft. If a character has no saved key position, skip that character and continue typing the mapped characters. Verify the text actually entered in the composer and send that entered text, not the original draft. Open Chat once, then wait up to 30 seconds for the Unread tab, checking every 5 seconds and tapping it as soon as it appears. After a reply, press Android Back twice to leave the chat; retain the existing Unread list without tapping Chat again.

**Why:** The user said clipboard paste does not work and explicitly requires Luna's response to be typed with calibrated keys. They clarified that opening a chat focuses the composer, so an extra field tap is unnecessary. Snapchat's empty composer placeholder “Send a chat” was previously misclassified as a draft because the code only recognized “Send chat,” which stopped replies before typing. They also specified skipping missing keys, waiting for the delayed Unread tab instead of double-tapping Chat, and refreshing Chat only between replies when another one will be sent. They run live phone behavior in Windows Electron; Replit is for prompt tests only.

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

**Link reply content:** The editable reply goal is the source of truth for Boundlus wording: answer the latest message briefly, use its exact call to action and URL, and do not add claims about Snap being overwhelming or private conversations.

**Why:** The attached current prompt explicitly prohibits the older “Snap is overwhelming” and private-conversation wording, and defines a different exact call to action.

**How to apply:** Keep the link timing and destination in the editable prompt. Do not duplicate prompt-specific wording as code checks or canned messages.

**Local time context:** Give Luna the host's current local date, time, and timezone. Treat transcript times as message-sent times; when a message is at least six hours old, use the current local clock for any time-of-day wording, and avoid guessing when age is unclear.

**Why:** The user reported that replies can treat an older nighttime message as if it were still midday when the response comes hours later.

**How to apply:** Keep the natural-language timing rule in the editable goal and pass current host-local clock metadata into Luna's request. This is context for wording, not a condition for rejecting or delaying a send.

**Post-link supporting replies:** Allow up to two supporting replies after the Boundlus link, for a maximum of five replies when the link is reply 3. The editable prompt defines the two supporting messages; each is generated from the conversation context.

Each supporting reply must explain that Boundlus is a new social media platform that pays people for uploading content, then invite the contact to create an account and add/connect with the sender. Keep this wording in the editable prompt; do not hardcode it.

**Why:** The user changed the post-link behavior from one clarification to two additional supporting messages, raised the conversation cap from three to five, and specified the value proposition each support reply should communicate.

**How to apply:** Keep the post-link message wording and conversational instructions in the editable prompt. Enforce only the generic limits in code: no more than five replies total and no more than two after the first Boundlus-link reply. Do not restrict follow-ups to questions about Boundlus.

**Unread list eligibility:** Treat the Snapchat Unread tab itself as the unread signal; do not require a row status to say “New Chat.” Keep “Received” and “Opened” rows eligible only when an actual readable message preview is present; skip “Delivered” rows because that indicates an outgoing message, not an incoming chat to answer. Never tap rows with an empty-chat/system placeholder or no readable message preview; status labels alone are not enough. Ignore pure Snap/photo/video rows, but allow a mixed media-and-chat row only through its separate chat-only right-side action icon. If a row passes the list check but opening it yields no readable conversation, exit it and continue to the next row rather than ending the tool.

**Why:** The run stopped after two replies because the row filter accepted only “New Chat” labels, although other text-chat rows remained in the Unread tab with statuses such as “Received” or “Opened.” A later run also treated rows marked “Delivered” as reply candidates and attempted to open an empty conversation. The user requires empty chats to be excluded before any tap; outgoing-only rows and empty threads must not prevent remaining unread contacts from being processed. The user also identified red photo and purple video reply icons as media replies and instructed the automation not to open them. A mixed “Snaps and Chats” row can expose a separate action icon that opens the chat without opening media.

**How to apply:** Verify the Unread tab is active, select named rows from it regardless of Received/Opened wording only when they also show a real message preview, and exclude Delivered-only rows. Before tapping, reject known empty/system placeholders and require message-preview text; a generic status such as “New Chat” is insufficient on its own. Filter media-only rows out regardless of icon color. For mixed rows, require the confirmed chat-only action icon and tap that icon instead of the row body. If a row still opens without readable conversation, exit and refresh the list before continuing.

**Unread reply count:** Reply to Unread Chats has no fixed upper cap; its configured Max is only the upper end of the user's selected count range.

**Why:** The user explicitly said there should be no maximum number of unread chats to reply to.

**How to apply:** Keep the UI, API validation, and run-count selection uncapped for this tool. The run still ends when it reaches the selected count or Snapchat has no more eligible unread chats.
