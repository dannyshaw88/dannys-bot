---
name: Phone Farm proxy goal
description: The user's stated reason for per-device proxy support.
---

The user wants each Phone Farm device to use its own HTTPS proxy instead of paying for a 4G SIM. The setting belongs in that device's My Device panel, with an explicit No proxy option. Do not require another third-party app on the phone.

**Why:** the user explicitly corrected the setting's placement and rejected a third-party app dependency.

**How to apply:** Add per-device controls to My Device and use the project's existing Android/ADB path; do not put the control on the Farm card or route it through Proxy Manager.
