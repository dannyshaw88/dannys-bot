---
name: Google Chrome browser click parity
description: Keep standalone Facebook interactions to one trusted native click to prevent toggle controls from immediately reversing.
---

For Send DMs, extract profile-ID links only from the exact Followers section. Do not infer a user from an arbitrary Facebook link and a Message button in a broad ancestor: the page header's Sign up link can inherit the Page's own Message button. Navigate to the selected user's profile, confirm its profile ID and name, and require exactly one Message control in the main profile area.

Require the message composer to identify the same recipient (for example, `Write to <user name>`), wait for that field to render instead of using a short fixed delay, and verify the configured text in the composer before sending. Use one native Puppeteer `ElementHandle.click()` for Message and Send; do not follow it with synthetic DOM click events.

**Why:** The prior broad ancestor scan selected a Page-level Sign up link and opened the Page's own Message panel. Its composer was not ready after the fixed 900 ms delay, so no message text was entered.

**How to apply:** Keep these recipient and composer checks limited to the synthetic Google Chrome Send DMs flow. Fail closed whenever the profile identity, unique Message control, recipient-specific composer, or typed text cannot be confirmed. Preserve existing click behavior for other browser sessions.
