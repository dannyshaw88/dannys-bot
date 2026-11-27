---
name: Google Chrome browser click parity
description: Keep standalone Facebook interactions to one trusted native click to prevent toggle controls from immediately reversing.
---

For Send DMs, extract profile-ID links only from the exact Followers section. Do not infer a user from an arbitrary Facebook link and a Message button in a broad ancestor: the page header's Sign up link can inherit the Page's own Message button. Navigate to the selected user's profile, confirm its profile ID and name, and require exactly one Message control in the main profile area.

Require the message composer to identify the same recipient (for example, `Write to <user name>`), wait for that field to render instead of using a short fixed delay, and verify the configured text in the composer before sending. Use one native Puppeteer `ElementHandle.click()` for Message and Send; do not follow it with synthetic DOM click events.

**Why:** The prior broad ancestor scan selected a Page-level Sign up link and opened the Page's own Message panel. Its composer was not ready after the fixed 900 ms delay, so no message text was entered.

**How to apply:** Keep these recipient and composer checks limited to the synthetic Google Chrome Send DMs flow. Fail closed whenever the profile identity, unique Message control, recipient-specific composer, or typed text cannot be confirmed. Preserve existing click behavior for other browser sessions.

Composer visibility alone is not proof that Facebook finished rendering it. Before typing, require the editable field to be writable, focused, and still attached; after typing, wait for the exact text to appear in that same field before enabling Send.

**Why:** The user observed chats opening before their composer was ready, causing messages not to appear in the field.

**How to apply:** Use bounded state-based waits for focus and exact text, then stop the run without sending if either state cannot be verified. Do not switch to another recipient after a composer readiness failure.

After confirming the profile, resolve the Message button from the live DOM immediately before clicking it. If the handle is detached or Puppeteer reports no clickable point, re-resolve and retry once; never reuse the stale handle or synthesize a DOM click.

**Why:** Windows logs showed both “Node is detached from document” and “Node is either not clickable or not an Element” before Message was pressed.

**How to apply:** Use a recipient/name-scoped live button lookup, preserve one native ElementHandle click per resolved node, log and retry transient node failures once, and stop at that profile if the fresh click also fails.

Facebook profile controls can appear well after `domcontentloaded`. After navigation, keep polling the verified profile for up to 30 seconds for its unique visible Message button; distinguish navigation timing from button-render timing in logs, and stop on timeout rather than hopping to another profile.

**Why:** The user observed a profile taking about 30 seconds to load, while the earlier implementation gave the CTA only a short readiness window.

**How to apply:** Poll in short bounded intervals so Stop remains responsive. Log navigation and button-ready durations plus privacy-safe diagnostics (`readyState`, matching-name boolean, visible Message-button count); never repeat a click after it succeeds.

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

**How to apply:** Key records by sender account and recipient Facebook ID, reserve before clicking Send, and inspect only the nearest chat panel uniquely owning the verified composer and close control. Check that panel's message rows (including media-only and older rows); do not use generic page-level “Messages” regions as evidence. The public-info notice can establish an empty thread only after settling and only when that panel has no message rows. Unknown/loading history must fail closed.

When multiple Send DMs message options are configured, send the full option list to the API and select an option separately for each recipient immediately before typing. Do not choose one option once per run and reuse it for every recipient.

**Why:** Choosing once in the UI before starting a run made every recipient receive the same selected option.

**How to apply:** Keep option parsing in the UI, but make the per-recipient send path choose and verify the selected text; retain compatibility with older clients that send one string.

In Send DMs messages, replace each `[FIRSTNAME]` token with the first word of the Facebook display name for that recipient. If the display name is one word, use that entire word.

**Why:** The user requested recipient-personalized Facebook messages using this exact token.

**How to apply:** Expand the token after choosing the recipient's message option and before typing, then verify the expanded text in the composer.

The configured Send DMs amount is a successful-send target. Filtered profiles and existing chats do not count toward it; keep discovering eligible profiles until the target is reached, discovery is exhausted, or the user's stop limit is hit.

**Why:** A run found one eligible profile after filtering 42 others and ended, although the user expects a configured minimum of three successful sends.

**How to apply:** Count only confirmed sends toward the target, continue harvesting eligible candidates until the target is met, the Followers list is exhausted, or the user's configured stop limit is reached, and report clearly when the target cannot be reached.

Wait for actual collected follower rows, not merely Facebook's page shell or early links, and do not use unchanged document height as proof that follower discovery is finished.

**Why:** Facebook can hydrate names and photos after its shell appears, and virtualised or nested lists can change their users without changing document height. Ignored readiness timeouts plus an unexplained empty result look like a stalled tool.

**How to apply:** Bound the wait, preserve discovered identities across scrolling, support an exact visible Followers span when semantic headings are absent, and show an actionable error when no readable rows or no eligible recipients remain. Keep routine progress/success narration hidden.

Finding no eligible profiles in the current batch is not proof that the Followers list is exhausted. Continue scrolling when filters reject every discovered profile; stop only after the actual scroll surfaces reach their bottom and the list remains settled without new rows, or the successful-send target/configured stop limit is reached.

**Why:** An unchanged candidate snapshot caused Send DMs to stop after eight scans, even though the user expected it to keep scrolling for profiles that might pass the active filters.

**How to apply:** Do not use a fixed count of unchanged IDs as the end condition. Scroll the Followers panel and page, preserve profiles across virtualized rows, and confirm stable end-of-list before reporting that no candidates remain.

Do not treat an emptied composer as proof a message was sent. Wait for the exact outgoing text to appear in a visible message row in that same conversation before counting the send or closing the chat. Keep uncertain attempts pending and reconcile the live conversation before retrying.

**Why:** The latest run cleared the composer and immediately closed the chat, then logged a successful send even though the user could not see the message render.

**How to apply:** Confirm the composer is empty and the matching message row is visibly rendered in the verified chat; otherwise leave the chat open, stop the run, and check the conversation history on the next run before sending again.

Send DMs must process one settled Followers viewport at a time: wait for its visible rows and photos to finish rendering, capture it, handle each user’s profile and chat, then return to that same viewport. Scroll only after all visible rows are handled. For Skip Already Messaged, screenshot text in the verified chat means skip. After Send, require both a visible outgoing row and screenshot OCR of the exact message before counting or closing.

**Why:** The user observed rapid scrolling and chat openings with no visible messages, and explicitly required rendered pages, screenshots of chat text, and skipping any conversation containing prior text.

**How to apply:** Keep the viewport stable through the profile/chat round trip, fail closed on unreadable screenshots or uncertain history, and never advance to another user after an unconfirmed send. Screenshot/OCR evidence is transient and must not be persisted.

For profile readiness, require screenshot OCR to confirm the selected profile name, but do not require OCR to read the Message button label. Confirm the unique visible Message control from the live DOM and click that element.

**Why:** Facebook rendered a valid profile and one visible Message button, but OCR could not read the button label and incorrectly stopped before clicking.

**How to apply:** Use screenshots for visible identity and chat text; use live, recipient-scoped DOM checks for controls. Keep the stricter exact-text screenshot check for the chat message after sending.

Every path leaving a profile—including an existing-chat skip—must restore the exact configured Followers page before the next scroll. Refuse to scroll whenever the active URL is not that configured page.

**Why:** A skip branch continued past the shared return logic, so Send DMs scrolled the recipient’s profile instead of the configured Followers list.

**How to apply:** Route successful sends and skips through the same return-and-settle step; test that a skipped chat restores the original URL before any scroll call.

For Google Chrome Send DMs, wait 30 seconds after loading the configured URL, after every actual scroll, and after each Message click; wait 60 seconds after each profile load and after returning to the configured Followers URL.

**Why:** The user explicitly required these fixed delays because page and chat content was advancing before it rendered visibly.

**How to apply:** Keep the waits hard-coded and Stop-responsive. Do not shorten them just because the DOM appears ready early.
