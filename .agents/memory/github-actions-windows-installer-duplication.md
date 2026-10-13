---
name: GitHub Actions Windows installer workflow duplication
description: Why this repo has multiple deprecated stub workflow files instead of deletions, and why a new Windows-installer workflow must never be added
---

`build-windows-installer.yml` is the single canonical GitHub Actions workflow
for building the Electron Windows installer (build web bundle → build
Electron bundle → `electron-builder --win` → upload/release the `.exe`).

Several near-duplicate workflows (`build-windows.yml`, `windows-installer.yml`,
`build.yml`, `release.yml`) previously ran on the same triggers (push to
main / tags), racing multiple redundant Windows-installer builds against each
other on every push and making "which run actually failed" hard to debug.
They were consolidated into `build-windows-installer.yml` and converted to
inert `workflow_call`-only stubs (deletion of these tracked files is blocked
in this environment) rather than removed.

**Why:** duplicate CI workflows silently multiply build minutes and produce
conflicting/confusing run results; the stubs exist purely so the files don't
vanish from history while guaranteeing they can never trigger again.

**How to apply:** never add a new `push`/`workflow_dispatch` trigger to any
of the deprecated stub files, and never create another new workflow file for
the Windows installer — extend `build-windows-installer.yml` in place if the
build/release pipeline needs to change.
