---
name: Males Only allowlist filter
description: The Follow filter uses explicit configured name tokens rather than gender inference.
---

The Males Only filter is an explicit allowlist. A candidate passes only when one configured comma-separated token appears in the HikerAPI profile username, full name, or biography, using case-insensitive substring matching.

**Why:** Gender cannot be safely or reliably inferred from names, photos, faces, or bios; the user specified a transparent name-based rule instead.

**How to apply:** Keep the setting Trust Score-controlled. Do not make it editable or copyable between individual Human Session Tool slots; allow it in Trust Score editing and Trust Score-to-Trust Score copying.