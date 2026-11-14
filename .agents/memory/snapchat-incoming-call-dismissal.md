---
name: Snapchat incoming-call dismissal
description: Decline incoming Snapchat calls without adding routine screen polling.
---

Only recognize an incoming-call surface when the live Snapchat UI contains an incoming-call label plus both Join and Not Now actions. Tap the exact live Not Now control; never tap Join or guess a coordinate.

**Why:** Incoming calls are rare, but must not be accepted, and repeated screen checks would slow normal phone automation.

**How to apply:** Piggyback recognition on UI hierarchy reads the active Snapchat flow already performs. On a match, re-read under the device input transaction, decline with Not Now, then return the refreshed screen to the caller. Do not add a timer or extra reads when no call prompt is present.
