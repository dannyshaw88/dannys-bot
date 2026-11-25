---
name: Snapchat reply-history identity and retention
description: Preserve correct contact identity and user-controlled retention for local Snapchat reply logs.
---

Snapchat reply history must match the current account's username plus the recipient's profile username. Slot ID and device are metadata, not account identity. Display names must not determine history lookup, link state, or reply counts. Do not merge unverified display-name history into verified usernames. Keep logs until cleared and clear only the selected slot. Scope link history and prior replies supplied to Luna to the account/recipient username pair.

**Why:** The user replaces banned accounts in existing slots. A replacement account must not inherit the old account's conversations; moving the same account between slots/devices must not create a different identity.

**How to apply:** Match both usernames for reads, grouping, writes, counts, and link history. Keep ownerless legacy records separate from named accounts.

### Conversation history storage

Conversation exit uses two Android Back presses separated by exactly one requested 500ms wait, without screen reads before or between the presses. Preserve cancellation and input-error handling.

**Why:** The user explicitly required two presses regardless of the intermediate screen and removed the intervening UI read to avoid its latency.

**How to apply:** Keep any caller's subsequent chat-list handling outside the two-press sequence.

Store one conversation per current account username and contact username. Merge sent replies and genuine failed attempts into that conversation, label each sender, and timestamp every event. Show conversations newest first, with each conversation's messages oldest first; failed sends must say `FAILED` with a reason. Do not store unread-list scans, Spotlight/media-only rows, false Delivered entries, or run-ended noise as conversation records. For incoming messages without Snapchat-provided timestamps, show when the message was observed rather than implying it was sent then. The bundled conversation store is canonical; legacy copies are not active history, and clearing a slot must clear that slot's records from both.

**Why:** the user explicitly asked for one simple, timestamped conversation per contact instead of split reply/audit entries, with only real conversation activity.

**How to apply:** keep exports and Luna's prior-reply context sourced from the same conversation records; preserve exact sent times, use `HH:MM-DD/MM/YYYY`, order conversations newest-first and messages within each conversation oldest-first, and keep clearing slot-scoped.

Open Chat once, wait for the Unread tab to appear, and tap Unread once. After exiting a replied conversation, the Unread filter remains selected; dump the list and continue without tapping Chat or Unread again. Choose eligible rows using their visible new-message markers.

Before opening each unread contact, rescan the current list and perform the row tap plus confirmation inside one per-device input transaction. If the same row remains visible and the chat did not open, retry once using its refreshed bounds; if it still does not open, skip that row and continue with other unread contacts.

An unread row can open a received photo/video Snap instead of the chat thread. When the live screen confirms Snapchat's media viewer, swipe down to close it, exit the conversation with the top-left chevron, verify the chat list, and continue to the next unread row rather than aborting the tool.

When replying, use the name at the top of the opened chat to visit the profile once, read and log its username, then return to reply. That profile username is the only recipient identity check. Do not require equality with an Unread-list label, revisit the profile before sending, or reject a sent reply because the header text changed. Continue using the profile username for Luna's prior-conversation history. Do not require a Send button before typing: Snapchat shows it only after reply text is entered.

**Why:** The user explicitly specified opened chat → tap top name → profile username → reply, with no other recipient checks. UI controls were being misread as contact names and name-comparison gates then blocked real opened conversations.

Before profile lookup, Luna generation, and typing, check the live conversation text for Snapchat's explicit "has not added you as a friend" notice. If present, skip sending and exit with the top-left conversation chevron; do not use the generic Report or block button as the signal.

Enter Snapchat replies using Android clipboard set-and-paste, not per-character `adb input text`; try Ctrl+V first because `KEYCODE_PASTE` can return without populating the composer, retry with the native Paste key only after checking the field, then press Android `KEYCODE_ENTER` (66) and confirm the message appeared and composer cleared.

**Why:** the user said display names can collide and provided a run where the selected contact, visible conversation, and saved reply did not match; name-only history cannot safely prove which person received the previous reply. They also chose to retain conversation logs until manually cleared, specified stopping replies after the link, want each slot to use its own Boundlus link, confirmed Unread stays selected after its first tap, and provided Inspect evidence showing the reply lives in the chat composer. Device evidence also showed non-friend notices, unread photo/video items, and overlapping input during an unread-row tap; these should be handled without sending to an undeliverable contact or abandoning the remaining unread chats.

**How to apply:** when changing Snapchat reply automation or its history UI, capture the recipient username from the profile screen and key reads/counts/writes by current account username plus recipient username. Never merge contacts by display name alone. Keep legacy name-only records separate rather than guessing their identity. Provide stored per-contact history to Luna, preserve the selected Unread list across chat exits without tapping bottom Chat again, and dismiss confirmed received media with a downward swipe before exiting and continuing.
