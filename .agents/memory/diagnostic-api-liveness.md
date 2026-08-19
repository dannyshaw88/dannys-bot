---
name: Diagnostic API liveness
description: Electron crash snapshots must track child exit state and read the configured API log
---

An Electron child-process object is not proof that the API is alive: `ChildProcess.killed` only reports whether a kill was requested. Crash diagnostics must maintain explicit exit state from the `exit` event and read the same configured log path passed to the child.

**Why:** A Windows snapshot reported the API as running and omitted its log after the child could have exited, making a desktop crash impossible to distinguish from a healthy process.

**How to apply:** When changing packaged Electron diagnostics or API child lifecycle handling, include exit code/signal, renderer liveness events, and the configured per-user API log tail.