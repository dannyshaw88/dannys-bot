---
name: Synthetic browser startup path
description: Startup constraints for the Phone Farm Browser tab's general-purpose Puppeteer session
---

Synthetic device-browser sessions are general-purpose browsers, not Instagram account sessions. They must not run Instagram proxy probes, proxy geolocation, cookie/device-token migration, Instagram request interception, popup recovery, cookie persistence, or blank-page login recovery before the stream is usable. An already-blank page must not be navigated to `about:blank` again.

**Why:** The shared Instagram embedded-browser path turned a simple Browser-tab open into a 20–30 second wait. A second independent failure came from the screencast serializer waiting on a promise that included its own invocation, causing a queue timeout before the first frame.

**How to apply:** Keep device-browser behavior guarded separately from account-profile behavior. When changing screencast serialization, ensure the outer queue owns serialization and the inner start function sends CDP commands directly; never await the shared queue from inside the queued function. The Browser panel should remain mounted while Mobile Farm tabs change, and a synthetic stream disconnect must not start the account-browser cleanup timer or navigate the existing page on reconnect.