---
name: Google Chrome browser click parity
description: Keep standalone Facebook interactions to one trusted native click to prevent toggle controls from immediately reversing.
---

For Send DMs, extract profile-ID links only from the exact Followers section. Do not infer a user from an arbitrary Facebook link and a Message button in a broad ancestor: the page header's Sign up link can inherit the Page's own Message button. Navigate to the selected user's profile, confirm its profile ID and name, and require exactly one Message control in the main profile area.

Require the message composer to identify the same recipient (for example, `Write to <user name>`), wait for that field to render instead of using a short fixed delay, and verify the configured text in the composer before sending. Use one native Puppeteer `ElementHandle.click()` for Message and Send; do not follow it with synthetic DOM click events.

**Why:** The prior broad ancestor scan selected a Page-level Sign up link and opened the Page's own Message panel. Its composer was not ready after the fixed 900 ms delay, so no message text was entered.

**How to apply:** Keep these recipient and composer checks limited to the synthetic Google Chrome Send DMs flow. Fail closed whenever the profile identity, unique Message control, recipient-specific composer, or typed text cannot be confirmed. Preserve existing click behavior for other browser sessions.

After confirming the profile, resolve the Message button from the live DOM immediately before clicking it. If the handle is detached or Puppeteer reports no clickable point, re-resolve and retry once; never reuse the stale handle or synthesize a DOM click.

**Why:** Windows logs showed both “Node is detached from document” and “Node is either not clickable or not an Element” before Message was pressed.

**How to apply:** Use a recipient/name-scoped live button lookup, preserve one native ElementHandle click per resolved node, log and retry transient node failures once, and stop at that profile if the fresh click also fails.

Match Facebook's Send accessibility label variants, including “Press Enter to send,” within the verified composer's conversation. After confirmed sending, close that same chat once and verify closure before advancing. Never search a shared multi-chat container or use an Enter fallback after an uncertain send.

**Why:** Exact “Send”-only matching can leave typed text unsent on Facebook variants, and sending alone does not close a chat. The user reported both an unsent draft and an unclosed chat.

**How to apply:** Check selectors with isolated DOM fixtures and the production dispatcher with browser-boundary stubs without sending real messages. Local fixtures are not proof of the user's signed-in Windows flow.

If a recipient's Message button opens but the matching composer is not found, stop after that recipient instead of continuing to open more chats. Log selector counts and recipient-match booleans without message text or profile names.

**Why:** A Windows run opened several chat windows but sent nothing; its log showed the composer readiness check timing out, followed by continued candidate processing.

**How to apply:** Fail closed on the first composer timeout, keep the current chat available for inspection, and record the visible editor/close-control counts and whether the recipient header matched.

Provide a saved Min/Max message delay in seconds immediately after the amount-of-users controls. Randomise each gap between successfully sent messages, not before the first or after the last, and keep Stop/time limits responsive.

**Why:** The user said sending was too fast and explicitly requested this placement and seconds-based range.

**How to apply:** Keep inter-message pacing distinct from the existing minutes-between-runs schedule. Default new settings to 30–60 seconds; validate the range in both UI and API.

When Girls Only is ticked, the user requires exactly one or two name parts, a profile picture, and no men's names regardless of language. Improve this existing checkbox rather than adding a separate review-first workflow.

**Why:** The user reported that men and business/non-person accounts were being messaged, and explicitly specified stronger requirements for the existing filter.

**How to apply:** Use positive recognised female first-name matching and reject unknown first names, known male/ambiguous name tokens, and missing pictures. Names/pictures cannot prove gender or authenticity; do not claim exhaustive recognition across every language.

Allow single-word, letters-only usernames containing a recognised female name, including joined first/surnames. Do not convert digit lookalikes into letters or allow numeric usernames.

**Why:** The user explicitly confirmed that real recipients can use made-up usernames containing a female name rather than a spaced personal name.

**How to apply:** Keep the photo requirement and male/business exclusions. Use at least four letters for embedded name matches to avoid accidental short fragments; exact recognised short names remain valid. This exception applies only to one-word usernames.

Female-name coverage must include Luna and Bambi; the user also confirmed Anya as eligible. Do not treat these examples as unknown names.

**Why:** The user explicitly corrected their rejection and said the recognised women's-name list was too narrow.

**How to apply:** Broaden coverage rather than treating a small list as comprehensive, while preserving the other eligibility requirements.

Use a documented international name source for broad coverage rather than adding only the names in each screenshot.

**Why:** The user repeated that the women's-name list was too narrow and explicitly asked to broaden it, suggesting Forebears if needed.

**How to apply:** Bundle licensed name facts for offline use, preserve accepted examples and other eligibility gates, and keep source/license attribution in packaged distributions. When expanding embedded-name matching, prefer leading/longest matches so overlapping fragments do not invalidate an accepted joined name.

Treat Alkaline and Belcalis as accepted names, allow a dot between first and surname, and recognise Miss as a title before a name. Lívia and Nicole must remain eligible.

**Why:** The user explicitly corrected these screenshot rejections and confirmed all five targets.

**How to apply:** Strip the title and normalise name-separating dots only for eligibility checks; retain original display names for recipient verification. Titles/dots must not bypass picture, numeric, male-name, business or two-name limits.

Skip Already Messaged must include existing Facebook conversations and survive Windows app restarts or interrupted sends; frontend URL history alone is insufficient.

**Why:** The user reported a repeat message on Windows after the recipient had already replied. Local app history cannot cover manually sent messages or a run interrupted before its response.

**How to apply:** Key records by sender account and recipient Facebook ID, reserve before clicking Send, and inspect only the verified recipient's conversation before typing. Unknown/loading history must fail closed. Do not mistake the introductory public-info notice above older messages for an empty conversation.

Wait for actual collected follower rows, not merely Facebook's page shell or early links, and do not use unchanged document height as proof that follower discovery is finished.

**Why:** Facebook can hydrate names and photos after its shell appears, and virtualised or nested lists can change their users without changing document height. Ignored readiness timeouts plus an unexplained empty result look like a stalled tool.

**How to apply:** Bound the wait, preserve discovered identities across scrolling, support an exact visible Followers span when semantic headings are absent, and show an actionable error when no readable rows or no eligible recipients remain. Keep routine progress/success narration hidden.
