---
name: UIAutomator attribute order
description: Android accessibility XML does not guarantee the order of node attributes
---

Never require text/content-desc to appear before bounds in a UIAutomator node. Parse the complete node attributes when locating live controls.

**Why:** A visible button such as Instagram’s “Next” can be present but missed by an attribute-order-sensitive regex, causing safe automation to abort or fall back to the wrong surface.

**How to apply:** Keep exact-label matching first, then use complete-node parsing as the order-independent fallback for every live UI selector.