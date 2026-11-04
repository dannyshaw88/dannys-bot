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

Reply 4 should retain the user's exact wording: “It’s a new social platform where people get paid for uploading content, add me on it.” If needed to answer or acknowledge the newest message naturally, add a short response before that exact sentence. Here, “it” refers to Boundlus in the same sentence. Reply 5 should first address the newest message, then use a distinct supporting message: “Just make an account and add me on it. You don’t make money on here, but on there you do.” Here, “here” means Snapchat and “it/on there” means Boundlus.

**Why:** The user wants Reply 5 to respond to the contact and add a new reason to join, not repeat Reply 4's description of Boundlus.

**How to apply:** Keep these wordings in the editable prompt. Do not hardcode them in software. Enforce only generic limits in code: no more than five replies total and no more than two after the first Boundlus-link reply. Do not restrict follow-ups to questions about Boundlus.

**Early media-request link:** Requests for pictures, photos, videos, nudes, or to see Luna skip directly to the link step and use “All of it’s on [Boundlus link]” without the usual Snapchat call to action. Treat it as the link reply, then use the next two post-link support replies after a new incoming message.

**Why:** The user wants media requests to skip straight to message 3 and direct the contact to the Boundlus link, rather than using the ordinary link-reply wording.

**How to apply:** Keep this as an editable-prompt route. Do not promise to provide media. Sexual propositions without a media request continue to use the normal link reply.

**Boundlus subscribers-only content:** Boundlus has a subscribers-only tab where creators can sell nude content. If asked whether the platform offers it, answer yes; distinguish that platform feature from whether Luna personally sells or sends such content.

**Why:** The user corrected a test response that denied the feature and clarified that it exists on Boundlus.

**How to apply:** Use the platform-feature answer for questions about the tab. Use the media-request route only when the contact asks for Luna's own pictures or videos.

**Boundlus earnings questions:** Distinguish Danielle's personal earnings from potential earnings. If asked how much she has made, say “£15, but I’ve only been on it for a few days.” If asked how much someone could make in general, use the specified answer about uploads, views, no algorithm restriction, and adding thousands of people. These answers replace generic Reply 4/5 copy for that turn.

**Why:** The user specified separate answers for personal earnings and general earning potential after the prompt misread “how much have you made?” as a potential-earnings question.

**How to apply:** Keep both answers in the editable prompt. Do not append the generic Reply 5 invitation to either answer.

**Persona and multi-part replies:** Persona facts belong to each editable account-slot goal. Treat that goal's PERSONA section as authoritative, keep examples consistent with it, and answer every direct question in the newest message in order, even when the reply must exceed the usual short-reply limit. Mention Quick Add only when the contact asks where they were found or added.

**Why:** A prompt test exposed conflicting identity details between the persona and examples, and a combined message asked several questions that the reply did not all answer. Slot-specific prompts may represent different personas, so one account's identity must not become a global default.

**How to apply:** Keep the persona, source-of-add rules, and reply wording in the editable prompt. When editing a slot prompt, align every example with that slot's PERSONA. Answer identity-only messages without mentioning Quick Add; answer a separate source question with “From Quick Add.” Avoid hardcoding slot-specific identity facts in shared generation code.

**Unread list eligibility:** Treat the Snapchat Unread tab itself as the unread signal; do not require a row status to say “New Chat.” Keep “Received” and “Opened” rows eligible only when an actual readable message preview is present; skip “Delivered” rows because that indicates an outgoing message, not an incoming chat to answer. Never tap rows with an empty-chat/system placeholder or no readable message preview; status labels alone are not enough. Ignore pure Snap/photo/video rows, but allow a mixed media-and-chat row only through its separate chat-only right-side action icon. If a row passes the list check but opening it yields no readable conversation, exit it and continue to the next row rather than ending the tool.

**Why:** The run stopped after two replies because the row filter accepted only “New Chat” labels, although other text-chat rows remained in the Unread tab with statuses such as “Received” or “Opened.” A later run also treated rows marked “Delivered” as reply candidates and attempted to open an empty conversation. The user requires empty chats to be excluded before any tap; outgoing-only rows and empty threads must not prevent remaining unread contacts from being processed. The user also identified red photo and purple video reply icons as media replies and instructed the automation not to open them. A mixed “Snaps and Chats” row can expose a separate action icon that opens the chat without opening media.

**How to apply:** Verify the Unread tab is active, select named rows from it regardless of Received/Opened wording only when they also show a real message preview, and exclude Delivered-only rows. Before tapping, reject known empty/system placeholders and require message-preview text; a generic status such as “New Chat” is insufficient on its own. Filter media-only rows out regardless of icon color. For mixed rows, require the confirmed chat-only action icon and tap that icon instead of the row body. If a row still opens without readable conversation, exit and refresh the list before continuing.

**Unread reply count:** Reply to Unread Chats has no fixed upper cap; its configured Max is only the upper end of the user's selected count range.

**Why:** The user explicitly said there should be no maximum number of unread chats to reply to.

**How to apply:** Keep the UI, API validation, and run-count selection uncapped for this tool. The run still ends when it reaches the selected count or Snapchat has no more eligible unread chats.
