---
name: Story comment composer detection
description: Story reply availability is identified by the stable composer resource-id, not one localized accessibility label.
---

## The rule

For View Stories emoji replies, treat Instagram's `message_composer_container`
resource-id as the authoritative signal that the reply bar is available. Treat
`Send Message or Reaction` and `Send message` labels as diagnostic only: they
can be absent, localized, attached to a child node, or renamed between
Instagram builds and UI dump formats.

**Why:** A live Xiaomi story dump showed a clickable message composer and
`composer_text="Send message"`, but the existing exact parent-description check
reported "message replies disabled" and skipped the configured comment
percentage.

**How to apply:** Match the resource-id suffix in the live Android XML, locate
that same node's bounds before tapping, and skip safely if the node or bounds
are missing. Log the container/label signals separately for future device
diagnosis.

## Keyboard emoji button

After the composer opens, the system keyboard is not represented in
UIAutomator. Locate its emoji key from a fresh screenshot by finding the
keyboard's bottom-row key immediately left of the wide space bar. Never use the
old bottom-left screen coordinate: on the Redmi A5 it landed in Android's
navigation bar, so subsequent emoji-picker swipes typed into the message field.

**Why:** The keyboard layout is outside Instagram's accessibility tree and its
vertical position varies with the device's navigation inset. A fixed
percentage can therefore tap a different surface while still looking
plausible in logs.

**How to apply:** Capture and decode the live screen, visually identify the
light keyboard region and its uniquely wide space-bar key, tap the adjacent
left key only when the geometry is unambiguous, and otherwise dismiss the
keyboard and skip the emoji action. Do not add a blind coordinate fallback or
retry tap.