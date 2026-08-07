---
name: DM inbox host — www vs i.instagram.com
description: direct_v2/inbox must go through www.instagram.com (web cookies) not i.instagram.com (mobile cookies) or it returns 4415001 for accounts whose ig_did hasn't been through mobile DM registration.
---

## Rule

All `direct_v2/inbox` and `direct_v2/threads` calls must use `webGet` (www.instagram.com + EB cookieJar) when a web session is present. The mobile API path (`mobileSessionGet`, i.instagram.com + mobileCookieJar) returns 4415001 "Prompt has contribution" for accounts imported from other tools, because the `ig_did` generated on this system is fresh and hasn't been through Instagram's device-level DM registration flow.

**Why:** This is the same root cause as the follow/repost host mismatch. The `i.instagram.com` mobile API is more restrictive about new devices for DM-specific endpoints. The web session (www.instagram.com) has no such restriction because it uses the account's real web-browser session identity.

**How to apply:**
- In any function calling `direct_v2/inbox` or `direct_v2/threads`: check `this.isLoggedIn` (web EB session present) first; if true, use `this.webGet(path)`. Only fall back to `this.mobileSessionGet(path)` when no web session exists.
- The warm-up sequence (`_buildWarmedIgClient` with user.info → news/inbox) is NOT the fix for 4415001 on direct_v2/inbox. Phase 2a/2b help other endpoints but NOT the DM inbox gate.
- `persistentBadging=true` in the URL also does NOT cause 4415001 — the host/cookie path is the real issue.
- `webGet` returns the raw JSON without throwing on 4xx; check for `status === "fail"` manually if needed.
- Affected call sites: `getDirectMessages`, `getDirectMessagesInternal` (Step 2 inbox + Step 3 thread), `getDMThreadsWithContent`, `shareStoryViaDm`, `getThreadIdWithUser` inbox scan.
