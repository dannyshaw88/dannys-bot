---
name: Share-sheet Strategy 2 label-scan exclusion list is a recurring leak surface
description: The DM share-sheet recipient label-scan fallback keeps leaking underlying feed/action-bar nodes through as fake "recipients" — each fix so far has been one more shape of the same leak, not a one-off bug.
---

## The rule

`findShareSheetRecipients`'s Strategy 2 (label-scan fallback, used whenever
Strategy 1's `grid_view_pog_avatar_view` resource-id lookup finds nothing)
scans ALL clickable nodes in the sheet's y-zone. The underlying feed post's
own action-bar nodes (Like/Comment/Repost/Send counts, caption hashtag
chips, "Add to Saved") remain present in the accessibility tree beneath the
sheet and pass through unless explicitly excluded by shape.

**Why:** three separate live-device incidents, same root cause category,
different exact shape each time:
1. Caption hashtag chips (`#foryou`, `#gymrat`) — excluded via `label.startsWith('#')`.
2. Plain-digit counts (`"203"`, `"9,077"`) — excluded via `/^[\d,.\s]+$/`.
3. Abbreviated counts (`"12.1K"`, `"1.2M"`) — the digit-only regex didn't
   match because of the letter suffix; excluded via `/^[\d,.]+\s*[KMB]$/i`.

Each was found only after a live failure produced a real device log +
node dump — guessing from memory would not have caught the specific shape.

**How to apply:** when a NEW share-sheet mis-tap surfaces, get the live
node dump first (per replit.md's diagnose-with-evidence rule), find the
exact label shape that slipped through, and add one more targeted
exclusion to Strategy 2 in `androidManager.ts` — do not rewrite the
filter architecture or add a generic catch-all, since Strategy 1 (the
resource-id path) is the trusted path and Strategy 2 only runs when it
fails. Treat any future leak here as "another shape of the same known
category," not a new bug class.
