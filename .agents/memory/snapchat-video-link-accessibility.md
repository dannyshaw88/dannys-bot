---
name: Snapchat Upload Video paperclip calibration
description: Use an explicit per-device Mirror Controls calibration for the Snapchat video editor Paperclip.
---

For Snapchat Upload a Video, first tap the live right-side downward More chevron to expand the editor toolbar, then tap the Paperclip using the per-device, display-bound `snapchatClickPaperclip` point captured in Mirror Controls. The chevron action must always precede the calibrated Paperclip tap. Do not use accessibility-name guesses, screenshot matching, or fallback taps for the Paperclip. If the chevron node or calibration is missing, stop rather than sending the Paperclip tap early.

**Why:** The user explicitly requested a calibrated tap in Mirror Controls to replace the existing paperclip lookup because the icon is visible after expanding the editor controls.

**How to apply:** Keep this Snapchat-only control separate from Instagram and WhatsApp controls. Show distinct app headings in Mirror Controls and route only Upload a Video's paperclip action through this calibration.
