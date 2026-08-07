---
name: Human Session Tool scroll owner
description: The nested settings panel owns the visible Human Session Tool page scroll during slot switching.
---

The visible Human Session Tool scroll position belongs to the inner `AutomationSettingsPanel` scroll container. Slot views are kept mounted, but restoring an outer wrapper's `scrollTop` does not preserve what the user sees.

**Why:** The first scroll persistence fix tracked the outer slot-view wrapper, while the actual rendered content scrolled inside the nested settings panel. Users still returned to the top when opening another account slot.

**How to apply:** Attach scroll tracking and restoration directly to the nested settings panel, and update the shared offset on every scroll event so all slot-selection paths can restore the same position.