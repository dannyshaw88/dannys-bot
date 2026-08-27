---
name: Mobile tab must never auto-wake the phone
description: LiveCanvas/mirror stream must only start on explicit user action (Power button) or automation toggle, never just from mounting/tab visit.
---

The phone mirror (`LiveCanvas` in `MobilePage.tsx`) used to mount and open its
WebSocket the instant a device showed `state === "device"`, regardless of
which tab the user was even looking at — this implicitly wakes/streams the
phone just from visiting the Mobile tab.

**Why:** starting the scrcpy/video stream has a real side effect on the
device (wakes the screen); doing that without the user asking for it is a
surprising, unwanted "ghost input" from the phone's perspective — indistinguishable from something clicking off-screen.

**How to apply:** gate any code that starts streaming/injects input against a
device on an explicit trigger — an on-screen Power button press, an automation
toggle, or an explicit Phone Farm device selection — never on component mount /
tab navigation alone. A device selection should open the mirror first; the
mirror's conditional screen-on check may wake a sleeping device but must return
immediately for an already-awake device. Also reset any such "live" flag when
the device disconnects so a reconnect doesn't silently resume streaming.
