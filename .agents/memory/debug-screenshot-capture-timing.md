---
name: Debug screenshot capture timing
description: How to correlate composite debug screenshots with automation input when per-device capture queues fall behind
---

Debug screenshot filenames are stamped when the queued ADB screencap begins, while the embedded rolling log can contain older elapsed-time entries because screenshots are serialized per device. Use the filename timestamp to order the phone frame; treat the visible log label as context, not proof of capture time.

**Why:** A queued screenshot labeled with an early HST event can be captured minutes later after the phone has changed screens, which can falsely make a later launcher frame appear to precede an earlier swipe.

**How to apply:** Correlate screenshot filename epoch times against raw `[mobile-input]` dispatch/completion timestamps. Do not infer input order from the elapsed timestamp printed inside the composite alone.