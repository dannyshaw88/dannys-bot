---
name: Follow exact-target gate
description: Safety rule for Human Session Tool Instagram follow searches
---

The Human Session Tool follow flow must positively match the requested username
exactly in the current Instagram accessibility tree before tapping any result.
Do not use a username TextView's `enabled` flag as an identity or tap gate: the
label can be disabled while its containing result row still responds to taps.
Avatar rings, first-result ordering, generic row containers, and DPAD navigation
are not sufficient identity evidence.

Search results are asynchronous: a single tree captured shortly after typing
can miss a result even while the device and Instagram remain responsive. Use a
small bounded sequence of fresh trees before reporting a miss.

**Why:** Instagram can omit the requested account from search results while
showing visually plausible profile rows. Selecting by position can therefore
follow the wrong account and derail the remaining target sequence. A bounded
wait addresses delayed labels without weakening the identity check. Separately,
UIAutomator can expose the exact visible username on a disabled text node even
when tapping that row opens the profile.

**How to apply:** After typing, poll a few fresh accessibility trees with a
bounded delay. If the exact normalized username is still absent, return failure
for that target, clear the search field, and continue safely. Match exact labels
regardless of the leaf node's enabled bit, then require a confirmed profile
surface after tapping before the caller can follow. Never guess.