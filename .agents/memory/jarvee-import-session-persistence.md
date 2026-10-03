---
name: Jarvee import session persistence
description: Jarvee parsed account details persist across in-app routes in memory only, not browser or database storage
---

The authenticated app-level Jarvee import session should retain the filename, parsed details, loading state, and errors across SPA route changes in memory only. Never write source files or extracted credentials, cookies, proxy secrets, or 2FA data to browser storage or the database by default. Clear the session on a full reload, app close, or explicit user clear.

**Why:** Jarvee exports can contain passwords, cookies, proxy credentials, and 2FA data; keeping them in memory solves navigation loss without creating another persistent sensitive-data store.

**How to apply:** Mount the import-session provider above the route switch, inside the authenticated app. Keep a visible clear action. If the user needs data to survive reloads or app restarts, first design encrypted storage and explicit deletion semantics.

Jarvee imports must preserve the source embedded-browser UA on the imported profile. Restore it in the Jarvee import path after profile creation; do not weaken the shared server-selected UA policy for ordinary profile creation.

**Why:** Imported browser identity should match the export while standard profile creation continues to use its server-assigned UA.

**How to apply:** Keep source `userAgentWeb` separate from the Instagram API UA and restore only the embedded UA for Jarvee-imported profiles.

When adding profile-export agents to the Ghost Browser pickers, expose one API row per distinct device string. If one API device has multiple embedded UAs, prefer the UA whose model token matches that device as the paired default, while keeping every distinct embedded UA selectable in the override picker.

**Why:** This avoids duplicate device choices and mismatched defaults without hiding any exported browser identity.

**How to apply:** Use this pairing rule when extending the bundled agent catalogs from Jarvee profile exports.