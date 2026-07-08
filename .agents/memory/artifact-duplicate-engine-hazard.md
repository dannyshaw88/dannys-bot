---
name: Artifact auto-creation duplicate-engine hazard
description: Replit's auto-added artifact workflows can run a second live copy of a stateful backend process; any singleton/stateful service needs a cross-process guard.
---

When the platform auto-registers artifacts for an existing project, it creates its own managed workflow that runs the *same* package's dev script (e.g. `pnpm --filter <pkg> run dev`) as a second, independent OS process — potentially with a different `cwd` (and therefore a different resolved data file path) than the pre-existing hand-configured workflow for that same package.

**Why:** For a stateful backend that polls/mutates an external live resource (e.g. an automation engine driving a real Instagram account via its API), two concurrent instances race on the same external account/session, which the external service can flag as a concurrent-session/suspicious-activity signal — real ban/lockout risk, not just wasted compute. It also causes any process-local, port-scoped resource (e.g. a subprocess sidecar bound to a fixed default TCP port) to crash-loop from a port collision.

**How to apply:**
- Never assume "one workflow = one process" once artifacts are involved. Check `System log status` / workflow list for duplicate workflow names running the same underlying script whenever a project has been auto-artifactified.
- For any singleton stateful service, implement a cross-process single-instance lock keyed to a filesystem location guaranteed shared across the duplicate processes regardless of `cwd` — e.g. `os.tmpdir()`, not `process.cwd()`-relative paths (since duplicate processes can have different cwd → different resolved data paths, e.g. two separate SQLite files, even though they were meant to be "the same" instance).
- Use an atomic acquire primitive (`fs.link()` test-and-set, not `writeFile`/`existsSync` check-then-write) with staleness-based takeover and token-verified periodic renewal, so a crashed owner doesn't permanently starve every other process.
- Release the lock on `SIGTERM`/`SIGINT`/`exit` (best-effort sync unlink) — otherwise every workflow restart makes the next owner wait out the full staleness window before it can take over.
- Guard the *actual work-launching entry point* (e.g. a `reconcile()` that spawns runners) with the lock-owned check, not just the top-level `start()` — HTTP-triggered manual-action routes on the non-owner process can otherwise bypass the lock via callback methods that also launch work.
- For any fixed-port subprocess (e.g. a Go/C sidecar for TLS fingerprinting) started by both duplicate processes, replace the fixed port with a dynamically-probed free port (bind to port 0, read back kernel-assigned port) instead of assuming exclusive use of the library's default port.
