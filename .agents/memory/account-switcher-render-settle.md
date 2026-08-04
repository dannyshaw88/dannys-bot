---
name: Account switcher render settling
description: Timing constraint for opening Instagram's account switcher on cold-start farm devices
---

The profile-tab node can enter the accessibility tree before Instagram has finished rendering the feed and bottom navigation. A long-press sent immediately after detection can be consumed by the still-settling surface instead of opening the account switcher. Each retry must use one accessibility dump only; do not nest popup-dismiss helpers that perform another dump, because a cold device can make a nominal 1.5s poll take 18–20s and become inconsistent.

**Why:** Cold-start and post-reconnect farm cycles expose a race between accessibility-tree availability and visible UI readiness.

**How to apply:** In the live mobile account-switch path, use one short bounded settle wait after profile-tab detection and before the long-press. Do not solve this with a second gesture or an unbounded retry loop.