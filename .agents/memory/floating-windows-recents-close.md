---
name: Floating-windows recents close gesture is LEFT-drag, not swipe-up
description: This device farm's recents/app-switcher is a Xiaomi "floating windows" carousel, not stock Android recents — dismissing an app requires dragging it off the left edge, and the leftmost-of-two-visible card must be targeted repeatedly when multiple apps are open.
---

## The rule

To close an app via the recents/app-switcher on these farm phones, drag the
app's card off the LEFT edge of the screen (long swipe, not a quick flick).
Swiping up is the stock-Android gesture and is a no-op on this launcher.

When more than one app is open, the carousel shows at most two cards side by
side at a time. Closing the left one slides the next app into the left slot
— so the "find left-most card, drag left" gesture must repeat (not just
retarget "Instagram" by name) until the target app's pid is confirmed gone.
With only one app open, its card is centred and the same left-drag from
centre applies.

**Why:** the previous implementation swiped the Instagram card upward, which
looked plausible (a normal Android dismiss gesture) but never worked on this
launcher — every cycle silently fell through to a force-stop despite the
code intending to look like a real person closing the app. User provided a
screenshot of the actual "Floating windows" overview confirming the
left/right card-strip layout.

**How to apply:** any future recents/app-switcher interaction on this farm
must use a left-drag of the left-most visible card, not an upward swipe, and
must repeat if the target app might not be the only (or left-most) card.

## Follow-up (11 Jul 2026): pidof checked too soon after a working swipe

A correctly-aimed drag was dismissing the card (user-confirmed visually),
but Instagram's background services kept the process alive past a single
600ms `pidof` check, so the code concluded the swipe had failed and
redundantly repeated it (up to 5x, ~20s wasted) against an already-closed
screen. Fixed by polling `pidof` for up to 3.5s after each swipe instead of
one point-in-time check.

Also: this launcher's recents dump has never exposed a text/content-desc
label for any card in real testing, so "count how many cards remain" has no
ground truth here — capped blind (no-label) retries at 2 instead of 5;
still loop the full 5 when real per-card labels ARE found on other devices.

**Why this matters generally:** a process being dismissed from a switcher
UI and its OS process actually terminating are two different events with an
unpredictable gap between them — never conclude "the gesture failed" from a
single fast liveness check right after a UI dismiss action.

## Related open hypothesis: per-device aspect-ratio calibration risk

Story tap coordinates and the story icon pixel-scan band are percentages of
screen w/h calibrated against one reference device (1080×2226). This farm
runs multiple phone models with different aspect ratios; a percentage-based
Y position or scan band tuned for one aspect ratio can miss the real UI
element on another. Suspected (not yet confirmed via log) as a contributor
to inconsistent story like/share success — the icon-scan band was widened
55–99% (from 70–97%) in response, and a resolution log line was added to
each stories run so the next failure can be cross-checked against actual
device resolution instead of guessed at.
