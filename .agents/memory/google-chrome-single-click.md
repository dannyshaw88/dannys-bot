---
name: Google Chrome browser click parity
description: Keep standalone Facebook interactions to one trusted native click to prevent toggle controls from immediately reversing.
---

For the standalone Google Chrome browser, dispatch one native mouse click only. Do not follow it with synthetic DOM click events: Facebook's Message action can open the chat panel on the native click and then close it when the synthetic clicks replay.

**Why:** The user confirmed the Facebook chat panel opened and remained visible after the browser was changed to send one click.

**How to apply:** Keep this special case limited to the synthetic Google Chrome session; preserve the existing click behavior for account/device browser sessions unless separately tested.
