---
name: Mobile HST background rendering
description: Keep background slot runtimes alive without mounting their expensive visible settings editors or Trust Score hydration.
---

Background Human Session Tool slots must preserve their automation hooks and scheduler state, but should not render the full settings panel or fetch full Trust Score-resolved settings while inactive and disabled. The visible editor hydrates those details on activation.

**Why:** Mounting one complete editor per slot created a render and request waterfall when opening Mobile or Statistics, even though most editors were hidden.

**How to apply:** Keep runtime hooks mounted for lifecycle continuity; gate expensive editor JSX, assignment hydration, and full settings fetches behind the active slot state.