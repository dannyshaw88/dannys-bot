---
name: Follow search miss execution gate
description: Stop the Follow tool after repeated exact search misses during one slot execution
---

Count only candidates whose exact usernames remain absent from Instagram search results. At the fifth miss, stop the current Follow candidate loop and skip remaining normal or Spread Follow entries for that account slot's current Human Session execution. Profile-quality filter rejections do not count. Start each later execution with a fresh counter; do not persist or share the gate across slots.

**Why:** The user requested a fail-safe for repeated inability to find a follow target, while explicitly excluding candidates rejected by configured suitability filters.

**How to apply:** Keep the miss callback at the exact-result-not-found boundary. Thread its execution-local state through normal Follow, Spread Follow, and backup retries; do not count filter skips, already-followed/global-skipped usernames, or future cycles.
