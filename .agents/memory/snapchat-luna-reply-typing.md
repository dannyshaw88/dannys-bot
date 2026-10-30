---
name: Snapchat Luna reply typing
description: How AI-generated Snapchat chat replies must be entered and verified.
---

Reply to Unread Chats must enter Luna's reply through the device's saved mirror keyboard calibration map, not clipboard or paste. Tap the composer once, then start typing immediately without an intermediate keyboard-open dump or check. If a character has no saved key position, skip that character and continue typing the mapped characters. Verify the text actually entered in the composer and send that entered text, not the original draft. Open Chat once, then wait up to 30 seconds for the Unread tab, checking every 5 seconds and tapping it as soon as it appears. After a reply, press Android Back twice to leave the chat; retain the existing Unread list without tapping Chat again.

**Why:** The user said clipboard paste does not work and explicitly requires Luna's response to be typed with calibrated keys. They also specified immediate typing after the composer tap, skipping missing keys, waiting for the delayed Unread tab instead of double-tapping Chat, and refreshing Chat only between replies when another one will be sent. They want prompt-only changes, use Replit for prompt tests, and use Windows Electron for live phone behavior.

**How to apply:** Keep other typing callers strict by default. Put Luna conversation wording and behavior constraints in the user's editable reply prompt, not fixed generator rules, unless the user explicitly asks for hard-coded enforcement. Use the Replit-only Luna sandbox for prompt tests; diagnose live phone behavior from Windows Electron logs and never claim Replit can trace the user's phone. For live Snapchat replies, skip only unavailable characters, continue the calibrated sequence, verify and record/send the actual composer contents, and use two Android Back key events after exiting each chat.

**Debugging log:** For live Snapchat replies, show the full Luna draft before typing and log concise action outcomes; suppress per-character progress lines.

**Why:** The user wants to inspect Luna's intended sentence while keeping the live log readable and focused on what the tool did.

**How to apply:** Keep detailed calibration diagnostics out of the Snapchat action log; retain actionable failures and the draft, typing, send, and completion results.

**Snapchat contact identity:** Read and retain the contact name from the unread-list row before tapping that same name to open the conversation. Do not inspect or validate the conversation header; require the chat composer before drafting.

**Why:** The user says the header can be obscured by banners and should not gate replies. The name on the unread list is visible before opening and is the intended contact identity.

**How to apply:** Capture the row name from one unread-list snapshot, then tap horizontally in the row's central text area at the name's vertical position, between the avatar and right-side action icon. Do not tap the avatar, action icon, or conversation header. Use the captured name for prompt context and reply history; after opening, check for a composer only.

**Snapchat panel navigation:** Close the Add Friends panel with one Android Back press after Add Friends or Accept Friends finishes. Do not tap the down-chevron or run a banner-clear check for this navigation.

**Why:** The user confirmed Android system Back is safe for leaving this panel and does not require banner checks.

**How to apply:** Keep banner checks for Add/Accept action buttons themselves, but use one system Back press to close the completed tool's panel.

**Prompt boundary:** Treat direct or indirect requests to see Luna, her appearance, photos, or videos as picture requests, including vague lines such as “let’s see you.” For these, and for sexual propositions or requests for nude content, send the Boundlus link reply immediately without asking what they have in mind or continuing sexual banter; stop replying after the link.

**Why:** A vague request to see Luna led the prompt to ask a suggestive follow-up instead of applying the intended Boundlus redirect.

**How to apply:** Keep this as editable reply-goal text, not fixed generator code. State explicit examples of indirect requests and make the immediate link-and-stop exception clear alongside the normal third-reply link timing.

**Link reply content:** Every Boundlus link reply must respond to the contact's latest message and give a clear reason to move, such as Luna being more active on Boundlus or Boundlus being better than Snap. A generic invitation alone is insufficient.

**Why:** The user said “Catch me on Boundlus” without a contextual response or reason to switch feels weak.

**How to apply:** In the editable prompt, require a brief response to the latest message plus the activity/benefit rationale, invitation, and exact URL, within the existing 20 supporting-word limit.

**Unread list eligibility:** Treat the Snapchat Unread tab itself as the unread signal; do not require a row status to say “New Chat.” Reply to named text-chat rows there even when the status says “Received” or “Opened,” and ignore rows marked as Snap, photo, or video regardless of icon color.

**Why:** The run stopped after two replies because the row filter accepted only “New Chat” labels, although other text-chat rows remained in the Unread tab with statuses such as “Received” or “Opened.” The user also identified red photo and purple video reply icons as media replies and explicitly instructed the automation not to open them.

**How to apply:** Verify the Unread tab is active, then select named rows from it regardless of status wording. Filter media-marked rows out before tapping, regardless of red or purple icon styling.
