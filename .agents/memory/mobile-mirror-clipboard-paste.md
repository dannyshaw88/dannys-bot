---
name: Mobile mirror clipboard paste
description: Manual right-click paste on the Android mirror must use native clipboard paste, not text injection
---

The Mobile mirror has a custom right-click clipboard menu. Right-click must not enter the normal pointer drag/tap state, and Paste must send the desktop clipboard to Android's clipboard service before firing `KEYCODE_PASTE`.

**Why:** Instagram's Bio and other custom editors can lose line breaks, punctuation, or special characters when driven through `adb shell input text`; treating the right-click as a tap can also move focus before paste.

**How to apply:** Keep manual mirror paste aligned with the Update Bio and Follow username paths. If the mirror input handler changes, preserve the non-left-button guard and the clipboard-paste endpoint.