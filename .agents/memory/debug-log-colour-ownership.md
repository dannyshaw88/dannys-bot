---
name: Debug log colour ownership
description: Persistent colour rules for the live Debugging Log and generated screenshot composites
---

The active tool owns the colour of its entire log block. A nested action or status word must not recolour a line: for example, a Reel opened from View Explore remains Explore green. System text is white. Account-switch blocks are gold, with only the destination handle highlighted pink.

**Why:** Content-based one-line classifiers made the same automation flow change colour mid-run and caused the live log and debug screenshot to disagree, making device debugging harder to follow.

**How to apply:** Update the frontend Debugging Log and server-side screenshot renderer together whenever tool headers or tool colours change. Preserve context until the next tool header or cycle boundary.

The Explore boundary must recognise every emitted Explore header form, including `Starting View Explore Page` and pre-switch Explore skip messages; generic `pre-switch` wording is not account-switch ownership.

**Why:** The renderer only recognised `View Explore` without the `Starting` prefix, so the prior gold account-switch context leaked into the Explore block shown in device screenshots.

**How to apply:** Let explicit Explore tool text reset the context before evaluating account-switch phrases, and keep the same precedence in the live React renderer and server-generated composites.

The server's rolling screenshot buffer must store the resolved context alongside each line. Never reclassify the visible 40-line window from message words after its tool header has rolled out; a Follow line mentioning a Reel must remain Follow-blue.

**Why:** The screenshot buffer can begin in the middle of a tool block, where content-only inference changed nested Reel text to red even though the active tool was Follow.

**How to apply:** Resolve context at log-ingest time, persist it by device, reset it at cycle boundaries, and leave unknown/system lines white until an explicit tool header establishes ownership.

The in-memory Debugging Log is per-device and per-active HST run, not a cross-account run history. Clear only that device's live debug lines when a run actually acquires the device, after any collision wait; preserve the separate Action Log and durable API diagnostics.

**Why:** Keeping previous accounts' lines in the live device buffer makes the current account's activity ambiguous.

**How to apply:** Route both UI-owned and background HST starts through the same per-serial clear signal after lease acquisition and before the new run's first log line. Never clear a device's active log while another account still owns the device.