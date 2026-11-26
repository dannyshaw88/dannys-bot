---
name: Synthetic browser startup path
description: Startup constraints for the Phone Farm Browser tab's general-purpose Puppeteer session
---

Synthetic device-browser sessions are general-purpose browsers, not Instagram account sessions. They must not run Instagram proxy probes, proxy geolocation, cookie/device-token migration, Instagram request interception, popup recovery, cookie persistence, or blank-page login recovery before the stream is usable. An already-blank page must not be navigated to `about:blank` again.

**Why:** The shared Instagram embedded-browser path turned a simple Browser-tab open into a 20–30 second wait. A second independent failure came from the screencast serializer waiting on a promise that included its own invocation, causing a queue timeout before the first frame.

**How to apply:** Keep device-browser behavior guarded separately from account-profile behavior. When changing screencast serialization, ensure the outer queue owns serialization and the inner start function sends CDP commands directly; never await the shared queue from inside the queued function. The Browser panel should remain mounted while Mobile Farm tabs change, and a synthetic stream disconnect must not start the account-browser cleanup timer or navigate the existing page on reconnect.

Invalidate the Browser panel socket generation before closing it during unmount. A late close event must not schedule a reconnect for a view that no longer exists; stale open/message callbacks must also be ignored.

**Why:** The user reported Google Chrome claiming “already open in another view” after leaving and returning. An unmounted view could reconnect in the background, and the duplicate-stream guard rejected the returning view despite there being only one persistent browser.

**How to apply:** Allow the standalone Chrome view to replace the existing stream via identity-safe attachment while preserving the browser/page. Do not attach sockets that closed during launch; preserve duplicate-view guards for other profiles/devices.