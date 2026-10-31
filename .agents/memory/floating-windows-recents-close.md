---
name: Floating-windows recents close gesture is LEFT-drag, not swipe-up
description: This device farm's recents/app-switcher is a Xiaomi "floating windows" carousel, not stock Android recents — dismissing an app requires dragging it off the left edge, and the leftmost-of-two-visible card must be targeted repeatedly when multiple apps are open.
---

## The rule

To close an app via the recents/app-switcher on these farm phones, drag the
app's card from the center of its thumbnail off the LEFT edge of the screen
(long swipe, not a quick flick). Use the live `task_view_thumbnail` bounds for
the swipe's vertical coordinate; the title text sits near the card's top and
is not the gesture start point. Swiping up is the stock-Android gesture and is
a no-op on this launcher.

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
left/right card-strip layout. A later inspect dump showed the card thumbnail
spanning y=805–1926 while the title occupied y=805–915; swiping at the title
band starts too close to the card header.

**How to apply:** any future recents/app-switcher interaction on this farm
must use a left-drag of the left-most visible card, not an upward swipe, and
must start at the actual thumbnail center and repeat if the target app might
not be the only (or left-most) card.

## Follow search-tab diagnostic rule

The UIAutomator root may omit its `bounds` attribute. The shared XML screen-size
helper has a desktop-sized `1600×900` fallback for unrelated coordinate callers,
but that fallback is not evidence of a phone floating window. Floating-window
detection must only compare real root bounds; when root bounds are absent, use
`adb shell wm size` for diagnostic cutoffs and do not relaunch Instagram.

**Why:** Follow was incorrectly logging a floating-window warning on a normal
Instagram screen, relaunching the app, then skipping the entire Follow step.

**How to apply:** Keep “unknown root size” distinct from “confirmed resized
window.” Preserve the fallback only for callers that explicitly need a usable
coordinate space.

## Safe card counting

Never use `pidof` as the signal to swipe another recents card. Android can keep
an app process alive after its card is dismissed, and a blind retry can close
other floating windows. Parse live UIAutomator node attributes independent of
attribute order, count distinct visible card labels, and continue only while
the target card is still visible and the observed count decreases. If the
launcher exposes no card labels/count, skip further recents swipes and use the
exact target-package fallback; do not guess how many cards remain.

**Why:** Repeating the gesture based on process liveness caused Step 3 to
dismiss additional floating windows after the target card was already gone.

**How to apply:** A card dismissal is verified from a fresh UI dump, not
`pidof`. Bound gestures by the observed card count and stop immediately when
the target label disappears or the count fails to decrease.

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
