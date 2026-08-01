---
name: Story like/share taps must re-verify the viewer is still open
description: Instagram stories auto-advance on their own timer; multi-step actions (esp. DM-share) can outlast a slide and taps then land on the home feed instead.
---

## The rule

Before every single tap in the story per-slide loop (like, start-share,
after-paper-plane-tap, after-recipient-tap, before-Send-tap, advance-to-next),
verify the story viewer is still actually on screen (bottom nav absent, via
`findHomeTab`). The instant it isn't, stop issuing further taps for the rest
of that story loop rather than assuming the next screen is still a story.

**Why:** Instagram stories auto-advance/exit on their own ~5-6s timer
regardless of what the automation script is doing. The DM-share sequence
(icon scan → tap paper-plane → wait → pick recipient → wait → tap Send) is a
multi-second chain of scripted waits that can easily outlast a single slide.
Every earlier fix in this area patched icon-detection heuristics (pixel
scanning, gap filters, keyboard-check safety nets) without ever questioning
whether the story was still open by the time each tap fired — so once a
story ended mid-sequence, every remaining tap fired blind at the real screen
underneath (the home feed), producing symptoms like "share to DM never
happened, instead it liked a random Reel on the home feed."

**How to apply:** Any new story-viewer automation step (or a new gesture
added to the existing per-slide loop) must call the same
`stillInStoryViewer()`-style check immediately before it acts, not just once
at story-open time. Also keep the pre-share watch-time cap (limit watch time
before a scheduled DM-share so the sequence has runway to finish inside the
slide's own lifetime) — don't let a "watch this story longer" tuning knob
silently eat the runway a later multi-step action needs.
