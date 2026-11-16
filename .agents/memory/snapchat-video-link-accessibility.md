---
name: Snapchat Upload Video paperclip calibration
description: Use an explicit per-device Mirror Controls calibration for the Snapchat video editor Paperclip.
---

For Snapchat Upload a Video, first tap the live right-side downward More chevron, wait 2.5 seconds for the toolbar to expand, then tap the Paperclip using the per-device, display-bound `snapchatClickPaperclip` point captured in Mirror Controls. After the link is attached, tap the top-right Text/T icon using the separate per-device `snapchatClickText` point from Mirror Controls. Do not use accessibility-name guesses, screenshot matching, or fallback taps for either calibrated control. If the chevron node or either required calibration is missing, stop rather than guessing a tap.

**Why:** The user requested per-device Mirror Controls taps after Upload a Video logs showed both the hidden Paperclip and the top-right Text/T icon could be missed by guessed or detected positions.

**How to apply:** Keep both Snapchat controls separate from Instagram and WhatsApp controls. Show distinct app headings in Mirror Controls; use Paperclip only after the More chevron and use Text only after the video editor/link-attach handoff.
