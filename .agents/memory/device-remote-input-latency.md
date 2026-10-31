---
name: Per-device remote input latency
description: Distinguishes slow ADB-injected actions from the typing pace configured in the app.
---

The user reports that physical touchscreen input responds quickly while remote actions sent to one farm phone—taps, swipes, and keyboard input—lag severely, despite the other devices using the same settings.

**Why:** Physical touches bypass the desktop's ADB control path. Identical speed profiles do not rule out a device-specific ADB transport, shell/input-dispatch, or local input-queue delay.

**How to apply:** Compare per-device input-gate wait with ADB command duration. High gate wait means the desktop queued the action; high command time means the ADB/device path is slow. Do not attribute broad remote-action lag to the typing profile without those measurements.
