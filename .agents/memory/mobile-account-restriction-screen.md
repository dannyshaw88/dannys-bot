---
name: Mobile account restriction screen
description: Instagram may show a blocking restriction surface during launch or account switching
---

When Instagram shows the “What happened” restriction surface, pause automation, select the live top-right close control from accessibility bounds, confirm the surface is gone, then restart the entire account-switch operation from a fresh UI dump. Never tap through it using feed coordinates.

**Why:** The restriction overlay blocks account switching and can make subsequent taps land on the wrong UI.

**How to apply:** Run the guard after Instagram launch handling and again after the account-switch tap; abort safely if the close control or dismissal cannot be verified, and allow only one full-flow recovery restart if dismissal succeeds.