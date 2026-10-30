---
name: Snapchat reply-history identity and retention
description: Preserve correct contact identity and user-controlled retention for local Snapchat reply logs.
---

Snapchat reply history must be associated with the persisted account-slot ID and the verified username shown on the contact profile; display names are not unique identifiers. Keep logs until the user clears them, clear only the selected Snapchat slot, and never send another reply after that slot's Boundlus link has been sent to the contact. Detect the Boundlus domain generically, not one fixed profile handle, because slots may use different links. Provide Luna with retained captured messages, exact prior sent text, and the outgoing reply number so follow-up replies continue the conversation instead of restarting or repeating.

Open Chat once, wait for the Unread tab to appear, and tap Unread once. After exiting a replied conversation, the Unread filter remains selected; dump the list and continue without tapping Chat or Unread again. Choose eligible rows using their visible new-message markers.

When replying, verify the chat header, tap the display-name text to read the profile username, then return to the thread before checking its composer. Do not require a Send button before typing: Snapchat shows it only after reply text is entered.

Before profile lookup, Luna generation, and typing, check the live conversation text for Snapchat's explicit "has not added you as a friend" notice. If present, skip sending and exit with the top-left conversation chevron; do not use the generic Report or block button as the signal.

Enter Snapchat replies using Android clipboard set-and-paste, not per-character `adb input text`; try Ctrl+V first because `KEYCODE_PASTE` can return without populating the composer, retry with the native Paste key only after checking the field, then press Android `KEYCODE_ENTER` (66) and confirm the message appeared and composer cleared.

**Why:** the user said display names can collide, chose to retain conversation logs until manually cleared, specified stopping replies after the link, wants each slot to be able to use its own Boundlus link, confirmed Unread stays selected after its first tap, and provided Inspect evidence showing the reply lives in the chat composer. Device evidence also showed a Snapchat notice that a non-friend cannot receive the message; replying to that contact wastes time and credits.

**How to apply:** when changing Snapchat reply automation or its history UI, capture the username from the profile screen, never merge contacts by display name alone, provide stored per-contact history to Luna, use stored link-sent and explicit non-friend notice checks as code-level gates (not prompt-only instructions), and preserve the selected Unread list across chat exits without tapping bottom Chat again.
