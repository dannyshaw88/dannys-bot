---
name: Manual vs automated input paths must share the same gesture primitives
description: Why fixing a gesture bug in one input path (automated) didn't fix it in another (manual) on the Mobile/USB-phone-farm tab
---

The Mobile tab has two independent code paths that send taps to the phone: the automated
Check Feed loop (backend-only) and the operator manually clicking the mirrored screen
(frontend pointer handler → REST call). A double-tap-to-like latency bug was fixed in the
automated path first (single adb shell call for both taps) but the manual path still built
its double-tap out of two separate single-tap HTTP requests, so the same bug persisted
there under a different code path.

**Why:** any two-tap/multi-tap gesture becomes unreliable if each tap is its own
network+adb round-trip; the on-device gap between taps needs to be controlled by a single
adb invocation with an in-shell `sleep`, not by two host-side calls with a delay in between.

**How to apply:** when fixing a gesture-timing bug for one trigger path (automated/API vs.
manual/UI) on this phone-mirror feature, grep for all call sites that could produce the same
physical gesture (tap, double-tap, swipe) before declaring it fixed — they often don't share
a code path even though they hit the same underlying adb primitive.
