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

### 2026-07-05 — Real click on "Select from Computer" was opening a real native OS file dialog (v1.1.357)
- Context: v1.1.356 made the click on "Select from Computer" a real trusted CDP click (fixing the "button never pressed" bug), but the user reported STILL zero progress — the flow now circles back to the homepage and "recycles" after ~5 refreshes, worse than before.
- Root cause confirmed from the real Instagram page source the user attached: the `<input type="file">` already exists in the DOM on the initial drag-and-drop screen, before the button is ever clicked — so the old "wait for a file input to exist" check always passed instantly regardless of whether anything worked, hiding the real problem. Once the click became a REAL trusted click (fixed in v1.1.356), clicking this specific button now does what it does for a real human: it asks Chromium to open the actual OS-native file-picker dialog. In a hidden/automated Electron window there is nothing that can interact with a native OS dialog, so it just sits open forever — the page underneath never receives a file, and whatever outer watchdog is driving the flow eventually times out and reloads the page. That reload-loop is exactly the "circles back to homepage, recycles" symptom.
- Fix: before clicking the button, arm CDP `Page.setInterceptFileChooserDialog({ enabled: true })` (after `Page.enable`) and listen for the `Page.fileChooserOpened` event on the debugger's `message` event. When Chromium tries to open the native dialog, CDP intercepts it and emits that event with a `backendNodeId` instead of ever showing the real dialog. We answer it directly with `DOM.setFileInputFiles({ files, backendNodeId })`. The native dialog is never shown, so there is nothing to hang on. Disabled interception again immediately after (success or failure) to avoid leaving the page in a weird state for later navigation.
- **Lesson**: fixing an "untrusted click is ignored" bug on a file-upload-triggering control can flip it into a NEW failure mode — a real trusted click on that specific kind of control can trigger a genuine OS-level dialog that automation cannot dismiss. Any control that opens `<input type="file">` picking must have file-chooser interception armed BEFORE the real click is dispatched, every time, not just "wait for the input to exist then inject."
- Status: UNCONFIRMED — pushed as v1.1.357, awaiting production confirmation from user.

### 2026-07-05 — Never actually clicked "Select from Computer" (v1.1.356)
- Context: v1.1.355 fixed Next/Share/Done clicks, but the very next report showed a regression to zero progress — the Create button still worked, but the blue "Select from Computer" button inside the "Create new post" dialog was never pressed at all, and the flow sat frozen on that screen every time.
- Root cause: the code never clicked that button in the first place. It only polled for `input[type='file']` to exist anywhere in the DOM and then injected the file directly into it via CDP `DOM.setFileInputFiles`, skipping the actual button click entirely. On a real Instagram feed page (lots of DOM behind the modal) this is fragile — the input may not be reliably locatable/wired without the click, and `DOM.getDocument({ depth: -1 })` (used to locate it) recursively pulls the ENTIRE DOM tree client-side, which is unnecessarily heavy on a big feed page.
- Fix: explicitly find and click the visible "Select from Computer" button with a real trusted CDP click (`spRealClick`) first — exactly what a human does — THEN wait for/inject into the file input. Also switched `DOM.getDocument` from `depth: -1` to `depth: 0` (root only) since `DOM.querySelector` resolves against Chrome's backend tree and doesn't need the whole tree pre-fetched.
- **Lesson reinforced again**: do not assume any UI transition happens "for free" via direct DOM/CDP manipulation without also performing the actual click a human would do. Every step in this flow must be audited for "did we actually click this, or did we assume it wasn't necessary?" — this is now the 3rd distinct click-related bug found in this single flow across 3 versions (Create, Next/Share/Done, Select from Computer).
- Status: UNCONFIRMED — pushed as v1.1.356, awaiting production confirmation from user.

### 2026-07-05 — Same untrusted-click bug also hit Next/Share/Done (v1.1.355)
- Context: v1.1.354 fixed the Create/Post click and was confirmed working in production — user reported the flow now gets past Create, the file picker appears, and the file injects successfully. But the flow then looped back to the homepage 5 times before giving up on that account.
- Root cause: the SAME untrusted-click bug (`.click()` + `PointerEvent`, always `isTrusted=false`) was still present in `spClickBtnText`, used for the crop "Next", filter "Next", "Share", and "Done" buttons. Only the Create/Post click had been migrated to the real CDP click (`spRealClick`) in v1.1.354 — these were missed.
- Fix: `spClickBtnText` now finds the button's on-screen coordinates and dispatches a real CDP click via `spRealClick`, then verifies the SAME button has disappeared from the DOM before declaring success (auto-retries if it's still there — safe for idempotent "Next" buttons, re-clicking twice has no side effect). Added a separate `spClickBtnTextOnce` (real click, no auto-retry) specifically for "Share" and "Done", since auto-retrying Share risks a duplicate post — success there is verified independently via the existing "Your post has been shared" text poll, not by re-clicking.
- **Lesson reinforced**: when the untrusted-click bug is found on one control, audit EVERY click in the same flow for the same pattern — do not assume fixing one button fixes the whole flow. Also: any auto-retry-on-click logic must consider whether the action is idempotent (Next = safe) or has real-world side effects (Share = never auto-retry the click itself, only the click's *coordinates lookup*, and verify success out-of-band).
- Status: UNCONFIRMED — pushed as v1.1.355, awaiting production confirmation from user.

### 2026-07-05 — EB-driven post flow: untrusted synthetic click root cause found (v1.1.354)
- Context: this is the EB (Puppeteer/embedded-browser) click-through path mentioned as "untried" above — NOT the mobile API path this file otherwise tracks. Posting is driven by clicking Instagram's own web UI (Create → Post → file picker → Next → Share) rather than calling the mobile API.
- Prior attempts (v1.1.351–353) fixed timing/wait issues (fixed sleeps → poll loops) but the Create button click kept silently failing — hover/highlight worked, nothing else happened.
- Root cause confirmed from production logs: the hover step used a real CDP-dispatched mousemove (isTrusted=true), but the actual click was a synthetic in-page `element.click()` / `PointerEvent`, which is always `isTrusted=false` per spec. Instagram's Create control silently ignores untrusted clicks on this specific control.
- Fix: dispatch the click via real CDP `Input.dispatchMouseEvent` (mousePressed + mouseReleased), the same trusted-click pattern already used elsewhere in `ebManager.ts` (ghost-signup nav, cookie banner dismissal). Also re-fetch the button's position after the hover/expand animation before clicking (sidebar shifts on hover), and verify success by checking the dropdown actually opened rather than trusting a JS boolean.
- **Lesson for any future "found the element but click does nothing" bug in the EB**: check whether the click is dispatched via synthetic JS (`.click()`/`PointerEvent`, always untrusted) vs real CDP `Input.dispatchMouseEvent` (trusted). Sites with bot-detection (Instagram in particular) can accept untrusted hover but silently ignore untrusted clicks on sensitive controls.

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
