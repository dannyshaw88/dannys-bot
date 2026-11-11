---
name: Farm device proxy routing
description: The requested Phone Farm network path and fallback for per-device proxy assignment.
---

Preferred Phone Farm networking: each phone uses the laptop's broadband connection as its transport, then exits through the proxy assigned to that device. If that cannot be supported, the acceptable fallback is for each phone to use its own Wi-Fi connection with its assigned proxy.

**Why:** The user stated this as the desired and fallback setup for the Phone Farm.

**How to apply:** Treat proxy assignment as device-level for phone-based actions, not as a replacement for existing account-level proxy assignments. Every account slot on a phone shares that phone's network path. Verify actual phone/app egress rather than assuming an Android global proxy setting guarantees all app traffic is proxied.

The selected USB route is a persistent desired setting: automatically reapply it when Aura or a phone restarts, and leave it enabled until the user cancels it. Aura must be running for the laptop-hosted relay to provide internet.

**Why:** The user explicitly requires per-device routes to survive restarts and updates until cancelled.

**How to apply:** Persist route-enabled state alongside the device's proxy assignment; distinguish cancellation from app shutdown, which should stop the relay but preserve the desired route for the next launch.
