---
name: Reel share-sheet resource-id alias
description: Instagram reuses the contact-avatar resource-id for external-share shortcuts in the Reel DM sheet
---

Instagram can assign `grid_view_pog_avatar_view` to WhatsApp/Share shortcut icons as well as real DM contacts. A nearby XML content-desc lookback is unsafe because it can borrow the preceding contact's name and produce a false recipient coordinate.

**Why:** A Reel DM run logged a real username beside a coordinate that was visibly the WhatsApp action-row icon. The tap launched WhatsApp, while the post-tap “sheet disappeared” branch incorrectly reported a successful DM.

**How to apply:** In the Reel Viewer path, derive the nearest actual ancestor content-desc from the XML tree, require a positive Chat-recipient marker, exclude external destinations, and require the selected contact plus the dedicated DM Send control before counting a DM. Never treat a dismissed share sheet as success.