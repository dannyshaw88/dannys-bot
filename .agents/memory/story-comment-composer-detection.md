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