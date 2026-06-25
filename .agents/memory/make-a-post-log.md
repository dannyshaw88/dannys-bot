---
name: Make a Post API failure log
description: Chronological record of every attempt to get Make a Post working via the mobile API. Read before touching anything in that feature.
---

# Make a Post — Attempt Log

**Why this file exists:** The Make a Post feature has been attempted ~20 times via the mobile API and has never worked. Every new session the agent repeats the same fixes. This file and the in-UI README-REPLIT block are the stop-gap.

## MANDATORY before any Make a Post fix attempt

1. Read this file top-to-bottom.
2. Read the README-REPLIT amber log block in `HumanSessionPanel.tsx` — it is rendered in the UI directly below the "Delete from PC after upload" checkbox inside the Make a Post / Source 2 (Local Folder) section.
3. Do NOT attempt any approach already listed below without a fundamentally different root cause.
4. After your attempt (win or fail), add a new dated entry to BOTH this file AND the README-REPLIT block in the UI.

---

## Known failure pattern (as of 2026-06-25)

The agent repeatedly cycles through these steps without resolution:
1. Fix media upload endpoint / URL path
2. Fix configure_video or configure_photo step
3. Add retry / backoff logic
4. Change Content-Type or multipart headers
5. → Loop back to step 1

None of these have produced a working post.

---

## Root cause (suspected, never confirmed)

`instagram-private-api` publish() calls fail silently or return 200 without actually posting.
The EB auth cookies work for browsing/follow/unfollow but the mobile API client may lack
the permission scope required for media publishing.

Additionally: the mobile API client session may be expired by the time the post is triggered
(the session is bootstrapped at verify time, hours/days earlier).

---

## What has NOT been tried

1. Driving the post entirely through the EB (Puppeteer clicking the Instagram web upload flow) — bypassing the mobile API entirely. This is the most promising untried path.
2. Intercepting the actual network request Instagram makes when the user posts manually in the EB (via CDP Network.responseReceived) and replaying those exact headers/body.
3. Explicitly checking `isMobileLoggedIn()` at post execution time — not just at verify time. The session may be stale.
4. Checking whether `mobileBootstrapFromWebCookies()` succeeds immediately before attempting to publish (not just at session init).

---

## Chronological entries (newest first)

### 2026-06-25 — ATTEMPT 2: Switched PATH B to CycleTLS (v1.1.160)
- Changed `_mobileRupload` from `forceNodeTls=true` → `forceNodeTls=false` (CycleTLS)
- Changed `_configureViaIgClient` from `forceNodeTls: true` → `forceNodeTls: false` (CycleTLS)
- Theory: rupload and configure must share the same TLS stack. CycleTLS mimics Android TLS fingerprint; Node.js HTTPS never worked.
- Result: UNCONFIRMED — user must run Make a Post and report back.
- If this fails: The TLS stack is NOT the root cause. Next step must be reading the actual error string from the activity log detail column.

### 2026-06-25 — README-REPLIT log block added to UI
- Added amber scrollable log box in HumanSessionPanel.tsx below "Delete from PC after upload" so future agent sessions see the history inline.
- No fix attempt made. This entry establishes the baseline.

### Pre-2026-06-25 — ~20 failed attempts (all prior sessions)
- PATH A: `ig.publish.photo()` via rebuilt IgApiClient — NEVER worked
- PATH B: hand-rolled rupload + configure, `forceNodeTls=true` — NEVER worked  
- Cycle: fix endpoint URL → fix configure body → add retry → change headers → repeat
- Confirmed: follows/unfollows work on same session (igApiCookies valid). Upload-specific failure.
- Error in activity log: "Upload failed for @X will retry next session" = `uploadAttempted > 0` branch at automationEngine.ts line 3131

**How to apply:** Before every Make a Post fix, read this file. After every attempt, prepend a new entry here AND in the UI block.
