---
name: DM share sheet blind-tap risk
description: A coordinate tap aimed at a modal (e.g. DM recipient avatar) must positively confirm the modal is on screen first — absence-of-side-effect checks are not the same as presence confirmation.
---

## The rule

When a scripted tap is aimed at an element that only exists inside a modal
sheet (bottom sheet, popup, dialog), gate the tap on POSITIVE evidence the
sheet is actually open — not just the absence of alternative outcomes (no
keyboard opened, still technically "in the same screen").

**Why:** In the story-share flow, the only gate before tapping a DM
recipient avatar (~15% from the left screen edge) was "no keyboard AND
still in story viewer" — true both when the sheet genuinely opened and
when the preceding tap landed on nothing at all. When the sheet didn't
open, that left-edge coordinate landed on the plain story screen
underneath, squarely inside Instagram's "go to previous story" tap zone —
producing a confusing "clicked backwards" bug that had nothing to do with
navigation logic and everything to do with an unconfirmed modal.

**How to apply:** find something that only exists when the modal is truly
open (e.g. a button label unique to that sheet, via an accessibility/UI
lookup) and require a positive match before firing the tap. If it can't be
confirmed, abort the action cleanly instead of tapping blind — a skipped
action is always safer than a coordinate tap landing on whatever is
actually behind the assumed modal.
