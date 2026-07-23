---
name: Imported workspace bootstrap
description: Imported pnpm workspaces may retain manifests and lockfiles without installed node_modules.
---

When an imported pnpm workspace reports missing executables such as `vite` or `esbuild`, restore the existing dependency graph with `pnpm install --frozen-lockfile` before investigating application code or changing manifests.

**Why:** Imports can omit the dependency store and workspace symlinks even when `package.json` and `pnpm-lock.yaml` are present; the resulting workflow failures look like code crashes but are only bootstrap failures.

**How to apply:** Check the lockfile and package manifests first, install from the lockfile, then restart the managed workflows and verify the actual artifact preview port.