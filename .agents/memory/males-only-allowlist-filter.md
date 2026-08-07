---
name: Males Only allowlist filter
description: The Follow filter uses explicit configured name tokens rather than gender inference.
---

The Males Only filter is an explicit allowlist. A candidate passes only when one configured comma-separated token matches the HikerAPI profile username or full name at the start/end or a `.`/`_` boundary, with an optional trailing numeric suffix of 1–4 digits. Biography matching remains case-insensitive exact-token matching.

**Why:** Gender cannot be safely or reliably inferred from names, photos, faces, or bios; the user specified a transparent name-based rule instead.

**How to apply:** Keep the setting Trust Score-controlled. Do not make it editable or copyable between individual Human Session Tool slots; allow it in Trust Score editing and Trust Score-to-Trust Score copying.