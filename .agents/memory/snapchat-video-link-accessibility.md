---
name: Snapchat Upload Video paperclip targeting
description: Target the video Snap Link tool through accessibility nodes and make misses actionable without screenshots.
---

For Snapchat Upload a Video, find the Paperclip/Link control from its live accessibility text, content description, or resource ID. Do not use screenshot-based icon matching or guessed coordinates. After opening More, use the fresh UI tree already required for the tap; if no control is identified, log the right-toolbar node IDs, labels, clickability, and bounds from that same tree, then stop without another tap.

**Why:** The user explicitly requires node targeting, rejects screenshots and fallback taps, and needs a useful explanation when the correct node is not exposed.

**How to apply:** Keep the failure diagnostic to one existing tree snapshot. Use its node evidence to identify the exact Paperclip/Link node before changing the selector; do not infer the icon from pixels or send speculative input.
