---
name: Story like/share timing starvation
description: A deliberate "watch the story first" delay before a scheduled like/share ate directly into the story's own fixed real-world timer, starving the multi-step DM-share sequence of the runway it needs to finish.
---

## The rule

Stories run on their own fixed real-world timer regardless of what the
automation script is doing. Any deliberate delay inserted *before* a
scheduled like/share (e.g. to simulate "watching" the story first) is time
taken directly out of that fixed timer — it is not a free/parallel wait.

**Why:** a DM-share is not a single tap — it's a multi-step sequence (icon
scan, tap, wait for sheet, pick recipient, wait, tap Send) that alone costs
several real seconds. Log evidence showed the share tap firing ~11.7s after
the story opened, well into a short story's lifetime, purely because a
"watch first" delay ran before the share sequence even started — the
sequence itself was fine, it just never got a fair shot at finishing before
the viewer auto-advanced/exited.

**How to apply:** whenever a scheduled action (like, share, or similar) is
time-sensitive relative to a fixed external timer the script doesn't
control, fire it immediately and reserve "natural-looking" pacing delays
only for moments when no time-critical action is pending. Don't add a
"realism" delay in front of an action that has its own downstream deadline.

See also `floating-windows-recents-close.md` for a related device-timing
lesson (checking whether a real gesture worked, too soon after it happened).
