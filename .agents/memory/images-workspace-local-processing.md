---
name: Images workspace local processing
description: The Statistics Images tool prepares local media for manual posting without uploading or overwriting originals.
---

The Images workspace must reuse the Make a Post Fix AI Slop and Image Alteration implementations, process each imported file independently, and export only processed copies. In Electron, native-selected files should be processed from their local path; the browser preview uses a data-URL fallback.

**Why:** This preserves the existing processing behavior while keeping the new workflow local and reversible for manual Instagram posting outside the application.

**How to apply:** Do not add a second image-alteration implementation, a Make it unique control, or an automatic Instagram upload/post step to this workspace.