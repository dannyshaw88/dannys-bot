---
name: Debug screenshot slot folders
description: Debugging evidence must follow Phone Farm slot order rather than USB serial or enumeration order.
---

Debug screenshot and session-recorder evidence folders use the persisted Phone Farm slot index with a normalized model label, such as `SLOT-1-REDMI-12`.

**Why:** USB/ADB enumeration order and serials are poor Windows sorting keys and can change when cables or devices change; the Phone Farm registry is the user-visible order.

**How to apply:** Resolve the serial through the `phone_farm_devices` slot registry for both capture and download/cleanup paths. Use an `UNASSIGNED-...` fallback only for devices outside the registry.

Evidence capture must also obtain a valid phone frame before creating the destination directory. During reboot/reconnect, ADB can be discoverable while screencap is unavailable and transient device-label lookups can fall back to the serial; neither condition should create a new serial-named folder.

**Why:** A restart window previously created a second serial-named history beside the established device-name folder.

**How to apply:** Capture first, return without filesystem writes when no frame is available, then resolve the folder from the stable registry and create/merge directories only after the device is back online.