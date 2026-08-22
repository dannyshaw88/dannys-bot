---
name: Mobile personality hydration
description: Persisted slot personality must survive the API-to-UI account response mapping
---

The mobile account loader must copy `personality` and `personalityOverrides` from the server response into React slot state. A persistence layer can be correct while the UI still shows Auto after restart if the response mapper only copies credentials.

**Why:** The restart regression was caused by the frontend mapping account responses into slots without carrying the saved personality fields forward.

**How to apply:** Whenever account-slot fields are added to the API schema, check the frontend hydration mapper and the first post-hydration save path together.