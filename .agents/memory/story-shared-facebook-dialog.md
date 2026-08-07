---
name: Story shared-Facebook dialog variants
description: Accessibility detection rule for Instagram's cross-platform shared-content education dialog during story viewing
---

The story viewer must auto-detect Instagram's “Interacting with content shared from Facebook” education dialog across title and accessibility-attribute variants, then tap its live primary OK node before continuing story actions.

**Why:** Instagram builds can expose the same blocking dialog with different title wording or put the title in a different accessibility attribute. An exact string match lets the dialog block the story loop indefinitely.

**How to apply:** Require the dialog container plus multiple shared-Facebook title signals, and resolve the button through its live primary-button resource ID or exact `OK` node. Never tap a generic OK without the dialog-specific guard.