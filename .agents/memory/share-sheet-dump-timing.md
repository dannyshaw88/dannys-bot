---
name: Share-sheet confirm+recipient-scan dump timing
description: Why confirming the DM share sheet open and picking a recipient must share one uiautomator dump, not two sequential ones.
---

Confirming the DM share sheet opened (label-match for "Send") and scanning for recipient avatars used to be two separate full `uiautomator dump` calls. On slower real devices each dump takes ~9s, so doing them back-to-back left the phone idle for ~18s+ with no interaction. A live log showed the recipient-scan dump returning the exact same feed action-bar nodes present *before* the share icon was tapped — proof the sheet had already closed and Instagram returned to the underlying post before the second dump ran. The existing recipient label-exclusion filters were working correctly; there was nothing left to find because the sheet was gone.

**Fix pattern:** `confirmAndScanShareSheet()` (androidManager.ts) does the Send-button confirmation AND the recipient scan from a single dump, and also returns a `sheetOpen` signal (presence of `direct_private_share` in that same dump) so callers can distinguish "sheet closed, 0 recipients" from "sheet open, genuinely 0 recipients" and retry accordingly.

**Why:** Every extra sequential `uiautomator dump` between a tap and the next action on this automation is several real seconds of dead time — on any UI element with a possible auto-dismiss/timeout, that dead time is exactly what causes the dismiss to happen mid-sequence. Minimize dump count on any multi-step tap-then-verify sequence, not just this one.

**How to apply:** When adding a new confirm-then-act pair against a transient UI surface (bottom sheet, popup, toast-triggered state), check whether both checks can share one dump before adding a second `_uiDump`/`findButtonByLabel` call. Also apply the "story-action-timing-starvation" caution: don't add retries on flows gated by an auto-advancing timer (View Stories) — only where re-tapping is safe (feed/reels/profile-browsing DMs).
