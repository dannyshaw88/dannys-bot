---
name: Males Only allowlist filter
description: The Follow filter uses explicit configured name tokens rather than gender inference.
---

The Males Only filter is an explicit allowlist. A candidate passes only when one configured comma-separated token matches the live profile username, display name, or biography. Usernames retain the start/end or `.`/`_` boundary rule with an optional trailing numeric suffix of 1–4 digits. Display names and biographies use case-insensitive Unicode word boundaries, so `Mario` matches `Mario Zone` but not `Marion`.

**Why:** Display names are human-readable and commonly contain spaces. Applying the username-only separator rule caused valid profiles such as `Mario Zone` to be rejected when `Mario` was configured.

**How to apply:** Keep matching field-specific: strict username-token rules for handles, Unicode word boundaries for display names and bios, and never use unrestricted substring matching or infer gender.

**Why:** Gender cannot be safely or reliably inferred from names, photos, faces, or bios; the user specified a transparent name-based rule instead.

**How to apply:** Keep the setting Trust Score-controlled. Do not make it editable or copyable between individual Human Session Tool slots; allow it in Trust Score editing and Trust Score-to-Trust Score copying.