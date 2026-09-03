---
name: Automation-cycle real-phone lifecycle
description: The master toggle runs a full power/open-app/run/close-app/airplane-recycle sequence each cycle, not just the scroll/like loop — and why certain steps use deterministic keycodes/verification instead of literal toggles/gestures.
---

Per explicit user instruction, each automation-cycle "tick" (while the
Human Session Tool master toggle is on) must: wake the phone, open
Instagram, run the scroll/like tools with configured settings, close
Instagram, cycle airplane mode off→wait 15-20s→on, then lock the phone —
recycling this whole sequence on every tick, not just running the
scroll/like loop directly.

**Why:** the user wants the device to behave like a person actually used it
between sessions (open/close the real app, real airplane-mode network
reset) rather than a script quietly driving gestures against whatever was
already on screen, or force-stopping the process invisibly.

**How to apply / pitfalls already hit:**
- Don't use a raw `KEYCODE_POWER` toggle for "power on"/"power off" — it's
  state-dependent (turns screen off if already on), so any step after it
  can run blind. Use `KEYCODE_WAKEUP` (224) and `KEYCODE_SLEEP` (223)
  instead — deterministic regardless of prior state.
- Don't rely solely on a recents-swipe gesture to "close the app
  completely" — dismiss direction/behavior varies by OEM launcher and
  Android version. Verify via `pidof <package>` after the gesture and
  fall back to `am force-stop` only if the process is still alive, so the
  human-like gesture is tried first but closure is still guaranteed.
- Toggle airplane mode via `cmd connectivity airplane-mode enable/disable`
  (with a `settings put global airplane_mode_on` + broadcast fallback for
  older builds) rather than tapping a quick-settings tile — tile position
  is not consistent across devices/OEMs, so a coordinate tap is unreliable
  at scale.
- Treat a successful airplane-mode command exit as insufficient on OEM phones:
  read back `airplane_mode_on`, use the settings+broadcast fallback when it
  did not change, and fail explicitly if the requested state cannot be verified.
- Before the initial wake→unlock sequence, hold Android's screen timeout at a
  long value and restore it during cycle cleanup. Some OEMs can let a very
  short timeout expire while the unlock swipe is still waiting on ADB/display
  setup.
- Keep a deliberate 1.5-second panel-settle delay between `KEYCODE_WAKEUP` and
  the first unlock swipe; the keyevent can return before the physical display
  and keyguard are ready, and a sub-second gap can lose the swipe.
- Treat `adb shell input swipe` exit-0 as host-command completion only. On the
  affected physical phone, a 60–100ms swipe beginning at 90% height was
  ignored by the keyguard with no visible motion. Unlock must use a dedicated
  touchscreen gesture from the bottom-edge system-gesture region with a
  normal drag duration, and log keyguard state before/after.

- Graceful reboot must use a bounded cycle-drain period and then force the ADB
  reboot if the worker is still registered. A synchronous/in-flight device I/O
  operation may never reach the abort checkpoint while the device remains
  online.

**Why:** Waiting indefinitely for `automationCycleInProgress` caused the
reboot endpoint to return an error and leave the physical phone running. The
reboot itself interrupts the stuck device operation; the worker's existing
catch/finally path then records partial metrics and releases the cycle lock.

**How to apply:** Mark the matching cycle ID aborted first, allow a short
normal unwind window, then dispatch `adb reboot` on timeout and return a
successful forced-cleanup result. Do not return a refusal solely because the
cycle marker is still present.
