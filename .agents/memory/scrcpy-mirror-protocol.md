---
name: scrcpy mirror wire protocol
description: Real scrcpy-server integration for the phone mirror (replaced adb screenrecord) — key protocol gotchas confirmed against decompiled server source.
---

The phone mirror (`artifacts/api-server/src/mobile/scrcpyServer.ts`) pushes
the official vendored `scrcpy-server` jar to the device and speaks its wire
protocol directly (no scrcpy client binary involved) instead of using
`adb exec-out screenrecord`. Root cause for the switch: `screenrecord` mirrors
a *virtual* display, which freezes on MIUI (and other OEM skins) when the
keyguard re-engages or the real screen sleeps — no such issue with scrcpy,
which captures the real display.

**Ground truth for the control-socket wire format is the *server's own*
`ControlMessageReader.parseXxx()` methods, not the desktop client's writer
logic remembered from general scrcpy knowledge.** These can disagree in
subtle ways — e.g. `TYPE_INJECT_KEYCODE`'s `action` field is 1 unsigned byte,
not a 4-byte int like the other three fields in that message (repeat,
metaState, keycode are all 4-byte ints) — an easy assumption to get wrong by
pattern-matching against the touch-event message, where every field but the
1-byte action *is* wide.

**How to apply:** if scrcpy's protocol needs to change again (new message
type, different server version), decompile the actual vendored server jar
with jadx (`jadx -d out/ vendor/scrcpy-server-v3.1`) and read
`com/genymobile/scrcpy/control/ControlMessageReader.java` directly rather than
recalling the format from memory — it's the definitive spec for what bytes
that exact binary expects, and takes under a minute to check.
