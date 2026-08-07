---
name: Story emoji composer gate
description: Story emoji automation must not require one Instagram composer resource-id before reaching the keyboard path.
---

Story reply bars can be visibly rendered while Instagram's UIAutomator tree omits `message_composer_container`. Locate the lower reply control using scored live nodes and log the matched bounds before tapping.

**Why:** A real Xiaomi/Instagram run skipped the entire keyboard flow at the old ID-only gate even though the reply bar and Gboard were visibly open. Automation retries are forbidden because they can consume timed story sequences and hide the actual detection failure.

**How to apply:** Use one live dump per action. Keep the composer locator conservative: restrict candidates to the lower screen, reject navigation/action resources, prefer reply labels, composer IDs, EditText nodes, and wide interactive controls, and fail closed when no candidate is found.