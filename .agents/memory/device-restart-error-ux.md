---
name: Device restart error UX
description: Keep ADB restart errors nonmodal without claiming an unconfirmed reboot succeeded.
---

Device restart failures and timeouts must not open blocking Electron/browser alerts. Keep diagnostic details in logs, and do not treat an ADB timeout as a confirmed successful reboot without evidence that the device returned.

**Why:** The user explicitly does not want a Windows Electron popup when restarting a device; an ADB timeout can indicate a reboot disconnect, but does not prove the phone restarted.

**How to apply:** Restart handlers should log errors and let device-status polling show disconnect/reconnect state. Preserve genuine API failure status and diagnostics rather than globally suppressing errors.