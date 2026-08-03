---
name: Imported workspace verification
description: Verification constraints for the imported Aura Farming workspace
---

For this imported workspace, the package-level API and frontend build commands are the reliable verification path used by the Windows installer CI. The root `build` script points at a legacy server path, and the broad workspace typecheck includes unrelated legacy/duplicate trees and mockup Vite version errors.

**Why:** The imported checkout can be healthy enough to build and run its active API/web artifacts even when the root convenience scripts and broad typecheck fail for pre-existing reasons.

**How to apply:** Install from the existing pnpm lockfile, run the API and frontend package builds directly, and report root-script/typecheck failures separately unless the user asks to repair that legacy debt.