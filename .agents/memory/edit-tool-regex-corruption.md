---
name: Edit tool regex safety
description: Avoid template-literal corruption when editing regex-heavy XML matching code.
---

When an Edit operation risks corrupting a template literal that contains regex backslashes, prefer `xml.includes()` over constructing a `RegExp`.

**Why:** backslashes in template literals can be altered by the editing operation and silently change the regex.

**How to apply:** use literal substring checks for the affected XML markers; only use dynamic regex where the escaping path is verified.