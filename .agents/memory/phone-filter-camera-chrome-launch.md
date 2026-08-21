---
name: Phone filter camera Chrome launch
description: Chrome first-run onboarding can intercept the phone-side filter camera URL
---

The phone-side filter camera must launch Chrome first, dismiss only positively detected Chrome onboarding surfaces, and send the camera URL afterward.

**Why:** A direct Android VIEW intent on a first-run Chrome installation leaves the URL behind the onboarding carousel, such as the “Download videos” page, so the user sees onboarding instead of the camera.

**How to apply:** For USB-connected phones, reverse the stable web-server port over ADB and use the phone-local URL. Prepare Chrome and handle known onboarding labels before issuing the final URL intent. Never tap arbitrary page content as a workaround.