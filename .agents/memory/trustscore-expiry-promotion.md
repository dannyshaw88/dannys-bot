---
name: TrustScore expiry promotion
description: Timer expiry must promote the slot label from the already-committed server result without a second assignment write
---

When a TrustScore timer expires, the timer-advance endpoint is the authoritative write for both the next assignment and its next timer. Update the shared client cache and publish the slot-change event from that committed response; do not call the ordinary assignment-save endpoint again.

**Why:** A second write at expiry can race or fail after the server has already advanced the timer, leaving the account-slot badge stuck on the previous label even though the countdown moved to the next tier.

**How to apply:** Keep all slot badges subscribed to `mobile_trustscore_changed`, and use the publish-only path for future server operations that already persist a TrustScore transition.