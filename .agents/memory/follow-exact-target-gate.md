---
name: Follow exact-target gate
description: Safety rule for Human Session Tool Instagram follow searches
---

The Human Session Tool follow flow must positively match the requested username
exactly in the current Instagram accessibility tree before tapping any result.
Avatar rings, first-result ordering, generic row containers, and DPAD navigation
are not sufficient identity evidence.

**Why:** Instagram can omit the requested account from search results while
showing visually plausible profile rows. Selecting by position can therefore
follow the wrong account and derail the remaining target sequence.

**How to apply:** If the exact username is absent after the normal result polling
window, return failure for that target, clear the search field, back out safely,
and continue with the next target. Never guess.