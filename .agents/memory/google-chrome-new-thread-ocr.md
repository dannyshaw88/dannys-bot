---
name: Facebook new-thread OCR
description: OCR and history rules for Facebook Messenger's new-conversation panel.
---

Facebook's profile card text—such as “1.3K people follow this,” “Model,” and “When you send a message … public info”—is not conversation history. Ignore rows containing only this default profile information. OCR artifacts from the tiny composer toolbar below the notice are not message history. When DOM history is unavailable, allow typing only after the screenshot clearly confirms the new-thread notice; DOM-confirmed message rows still block sending.

A configured “Message to DM” phrase can confirm a previous outgoing message only when the same phrase is visible in a DOM-confirmed message row. The UI splits alternatives on `!!` before passing them to the API.

**Why:** Facebook's default profile card and tiny compose icons were mistaken for prior messages, while the DOM history probe returned unknown, so the macro stopped before clicking the composer.

**How to apply:** Upscale the chat-panel screenshot for OCR, ignore toolbar text below the new-thread notice, strip default profile text from generic rows, and retain tests for empty threads, actual rows, and configured-message matches.
