---
name: Mobile cycle cross-tool metrics
description: Mobile Human Session cycle totals aggregate successful actions across every content tool and preserve pre-switch account ownership
---

The MobilePage phone-farm cycle uses one aggregate total for successful content actions: View Feed, Stories, Explore, Reels, and inject browsing. Likes, Feed shares, DMs, and saves from each tool must be added to the cycle total, returned to MobilePage, shown in cycle activity summaries, and persisted to mobile Statistics.

**Why:** The user expects Statistics and cycle summaries to represent every successful action performed anywhere in the Human Session cycle, not only the tool that happened to run last. Pre-switch work also belongs to the previous account, not the account selected afterward.

**How to apply:** Keep per-tool operation results separate, add them into cycle totals instead of overwriting shared counters, and persist pre-switch results directly to the previous account before the account switch.