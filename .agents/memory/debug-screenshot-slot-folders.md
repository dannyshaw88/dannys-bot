---
name: Debug screenshot slot folders
description: Debugging evidence must follow Phone Farm slot order rather than USB serial or enumeration order.
---

Debug screenshot and session-recorder evidence folders use the persisted Phone Farm slot index with a normalized model label, such as `SLOT-1-REDMI-12`.

**Why:** USB/ADB enumeration order and serials are poor Windows sorting keys and can change when cables or devices change; the Phone Farm registry is the user-visible order.

**How to apply:** Resolve the serial through the `phone_farm_devices` slot registry for both capture and download/cleanup paths. Use an `UNASSIGNED-...` fallback only for devices outside the registry.