---
name: Farm device proxy routing
description: The requested Phone Farm network path and fallback for per-device proxy assignment.
---

Preferred Phone Farm networking: each phone uses the laptop's broadband connection as its transport, then exits through the proxy assigned to that device. If that cannot be supported, the acceptable fallback is for each phone to use its own Wi-Fi connection with its assigned proxy.

**Why:** The user stated this as the desired and fallback setup for the Phone Farm.

**How to apply:** Treat proxy assignment as device-level for phone-based actions, not as a replacement for existing account-level proxy assignments. Every account slot on a phone shares that phone's network path. Verify actual phone/app egress rather than assuming an Android global proxy setting guarantees all app traffic is proxied.
