---
name: Desktop UA for disableApi accounts
description: When Disable API is enabled, accounts get desktop Chrome UAs → full Instagram desktop layout with no fingerprint mismatch risk.
---

## Rule
Accounts with `apiLimits.disableApi === true` are assigned a desktop Windows/macOS Chrome UA (no "Mobile" keyword) everywhere a UA is auto-picked.

**Why:** With no mobile API client, there is only one consumer of the session — the EB. One device, one identity, no mismatch. Desktop UA → Instagram serves full desktop layout with sidebar. Mobile UA → mobile web layout. The previous approach (force desktop UA as an override while keeping mobile UA internally) caused bans because the session appeared from two different devices.

**How to apply:**
- `pickDesktopUAForAccount(username)` — deterministic desktop UA picker (same hash as mobile picker), lives in `routes/instagram.ts`
- `desktopUserAgents` export in `shared/userAgents.ts` — 26 Windows/macOS Chrome entries, `api: ""`
- `generateEbFingerprint(apiUA, desktopMode?)` — pass `desktopMode=true` for desktop accounts → picks from `DESKTOP_GPU_POOL` (ANGLE NVIDIA/AMD/Intel/Apple Metal strings)
- Detection: `!ua.embedded.includes("Mobile")` → isDesktopUA
- Paths that auto-pick desktop UA: profile create, reset-device-ids, EQX import, bulk import, `browserSession.ts` auto-generate
- Jarvee import does NOT auto-detect disableApi (not in file format) — user should reset device IDs after setting disableApi

**ebManager.ts:** No changes needed. `_fpIsMobile = false` for desktop UAs → `_mobileProfile = null` → 1280×820 window, no touch emulation, fingerprint script desktop branch runs automatically.
