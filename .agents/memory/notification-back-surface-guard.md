---
name: Notification back-surface guard
description: Calibrated upper-left Back can become Home's Create button when the notification/detail surface disappears
---

The Random Actions notification flow must confirm the live notification page before its final calibrated Back tap, and confirm a live Back/Close control before cleaning up after an opened notification item.

**Why:** On the Home feed, the same calibrated upper-left coordinate is Instagram's `+` Create control. A blind Back tap can therefore open the camera/permission surface and make the preceding action look like an unrelated navigation error.

**How to apply:** Treat a notification screenshot or log as inconclusive unless the live UI surface is confirmed at the moment of the tap. If the surface is absent or ambiguous, skip the tap and log the reason rather than guessing.