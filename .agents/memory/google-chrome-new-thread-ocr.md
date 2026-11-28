---
name: Facebook new-thread OCR
description: OCR and history rules for Facebook Messenger's new-conversation panel.
---

An explicit “When you send a message … public info” notice means the conversation is new. OCR artifacts from the tiny composer toolbar below that notice are not message history. When DOM history is unavailable, allow typing only after the screenshot clearly confirms that notice; DOM-confirmed message rows still block sending.

**Why:** A real Facebook screenshot was classified as an existing conversation because Tesseract misread the compose icons and the DOM history probe returned unknown, so the macro stopped before clicking the composer.

**How to apply:** Upscale the chat-panel screenshot for OCR, ignore toolbar text below the new-thread notice, and retain a test for the screenshot-empty / DOM-unknown path plus a separate test that existing message rows still prevent sending.
