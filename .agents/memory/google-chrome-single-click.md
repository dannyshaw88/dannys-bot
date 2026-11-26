---
name: Google Chrome browser click parity
description: Keep standalone Facebook interactions to one trusted native click to prevent toggle controls from immediately reversing.
---

For Send DMs, extract profile-ID links only from the exact Followers section. Do not infer a user from an arbitrary Facebook link and a Message button in a broad ancestor: the page header's Sign up link can inherit the Page's own Message button. Navigate to the selected user's profile, confirm its profile ID and name, and require exactly one Message control in the main profile area.

Require the message composer to identify the same recipient (for example, `Write to <user name>`), wait for that field to render instead of using a short fixed delay, and verify the configured text in the composer before sending. Use one native Puppeteer `ElementHandle.click()` for Message and Send; do not follow it with synthetic DOM click events.

**Why:** The prior broad ancestor scan selected a Page-level Sign up link and opened the Page's own Message panel. Its composer was not ready after the fixed 900 ms delay, so no message text was entered.

**How to apply:** Keep these recipient and composer checks limited to the synthetic Google Chrome Send DMs flow. Fail closed whenever the profile identity, unique Message control, recipient-specific composer, or typed text cannot be confirmed. Preserve existing click behavior for other browser sessions.

Match Facebook's Send accessibility label variants, including “Press Enter to send,” within the verified composer's conversation. After confirmed sending, close that same chat once and verify closure before advancing. Never search a shared multi-chat container or use an Enter fallback after an uncertain send.

**Why:** Exact “Send”-only matching can leave typed text unsent on Facebook variants, and sending alone does not close a chat. The user reported both an unsent draft and an unclosed chat.

**How to apply:** Check selectors with isolated DOM fixtures and the production dispatcher with browser-boundary stubs without sending real messages. Local fixtures are not proof of the user's signed-in Windows flow.

Provide a saved Min/Max message delay in seconds immediately after the amount-of-users controls. Randomise each gap between successfully sent messages, not before the first or after the last, and keep Stop/time limits responsive.

**Why:** The user said sending was too fast and explicitly requested this placement and seconds-based range.

**How to apply:** Keep inter-message pacing distinct from the existing minutes-between-runs schedule. Default new settings to 30–60 seconds; validate the range in both UI and API.

When Girls Only is ticked, the user requires exactly one or two name parts, a profile picture, and no men's names regardless of language. Improve this existing checkbox rather than adding a separate review-first workflow.

**Why:** The user reported that men and business/non-person accounts were being messaged, and explicitly specified stronger requirements for the existing filter.

**How to apply:** Use positive recognised female first-name matching and reject unknown first names, known male/ambiguous name tokens, and missing pictures. Names/pictures cannot prove gender or authenticity; do not claim exhaustive recognition across every language.
