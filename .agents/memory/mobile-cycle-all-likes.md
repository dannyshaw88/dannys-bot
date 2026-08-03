---
name: Mobile cycle all-likes statistic
description: MobilePage Human Session cycle Likes combines successful likes from Feed, Stories, Explore, and Reels.
---

The MobilePage phone-farm cycle uses one Likes total for all content tools: View Feed likes + Story likes + Explore likes + Reels likes. That same total must be returned to MobilePage, used in cycle activity summaries, and persisted to mobile Statistics.

**Why:** The user expects the single MobilePage Likes statistic to represent every successful like performed anywhere in the Human Session cycle, not only Feed and Reels.

**How to apply:** When adding another mobile tool that can like content, include its successful-like count in the cycle total before response, logging, and `incrementMobileStats`.