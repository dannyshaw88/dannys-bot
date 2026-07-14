---
name: Phone mirror shell dead-space (pillarbox) root cause
description: Why the phone mirror's black shell left visible black margins around the mirrored screen, and why "just widen it" was rejected as the fix.
---

Applying the phone's real aspect ratio to the *whole* shell (header bar + screen area combined) is wrong — the header has a fixed pixel height that isn't part of the phone's screen, so forcing the whole box into the phone's ratio makes the video area proportionally narrower than the real device. The canvas correctly preserves aspect ratio when drawing frames, so it pillarboxes (black bars) to compensate — and since that sits on the same black background as the shell, it reads as "the shell is loosely wrapped" rather than "the canvas is pillarboxing."

**Fix:** apply `aspect-ratio` only to the screen area (using the height it's actually given after the header is subtracted by flex layout), not to the header+screen box as a whole. Let the shell shrink-wrap to that resolved width instead of being stretched.

**Why this matters beyond this one bug:** the user asked to fix this by literally widening the mirror ~10% each side. That was rejected — stretching the displayed image breaks the 1:1 click-to-tap coordinate mapping, which is the single most fragile, repeatedly-debugged part of this codebase (see the tap-offset/rescale entries elsewhere in memory). When a user's proposed fix for a *visual* symptom would require distorting the *coordinate space* of a feature with known fragile tap accuracy, prefer diagnosing and fixing the actual layout bug over implementing the literal ask — but explain the tradeoff, don't just silently ignore the request.

**How to apply:** any time this app's phone-mirror aspect-ratio math is touched again, check whether the ratio is being applied to a box that includes non-screen chrome (headers, toolbars) — that mismatch is the root cause pattern here, and will recur if reintroduced elsewhere (e.g. a future footer/toolbar under the mirror).
