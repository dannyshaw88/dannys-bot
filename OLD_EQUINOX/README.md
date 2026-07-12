# OLD_EQUINOX — frozen snapshot (mobile-emulation era)

This branch is a **frozen, encrypted, do-not-touch backup** of the Equinox
codebase exactly as it stood on 2026-07-12 (commit `a5918f8`, v1.1.519),
right before starting a rework away from mobile emulation.

Equinox originally shipped as an API + embedded-browser automation tool,
then pivoted to Android mobile emulation. This snapshot preserves that
mobile-emulation era in full so it can be recovered later if that direction
turns out to be a dead end and the API/browser-automation approach is
revisited instead.

## What's inside

`OLD_EQUINOX_snapshot.tar.gz.enc` — an AES-256-CBC (PBKDF2, 200000 iterations)
encrypted tarball of the entire project at that point in time: source code
(`artifacts/`, `lib/`, `server/`, `scripts/`), CI workflows (`.github/`),
agent memory (`.agents/`), the SQLite database (`database.db`, normally
git-ignored — included here for a true point-in-time snapshot), attached
assets, and all top-level config files (`package.json`, `pnpm-lock.yaml`,
`.replit`, etc). `node_modules`, `.git`, and Replit-local cache/agent-runtime
directories are excluded (regenerable via `pnpm install`).

## How to recover

1. Check out this branch and decrypt the archive:
   ```bash
   git fetch origin OLD_EQUINOX
   git checkout origin/OLD_EQUINOX -- OLD_EQUINOX/OLD_EQUINOX_snapshot.tar.gz.enc
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
     -in OLD_EQUINOX/OLD_EQUINOX_snapshot.tar.gz.enc \
     -out OLD_EQUINOX_snapshot.tar.gz
   # you will be prompted for the password
   tar xzf OLD_EQUINOX_snapshot.tar.gz
   ```
2. This restores the full project tree as it was at that moment. Copy what
   you need back into the `main` branch, or use it as a standalone reference
   copy — do not push further commits onto this `OLD_EQUINOX` branch.

There is also a plain (unencrypted) git tag on `main` pointing at the same
commit — `old-equinox-mobile-era` — for a quick, no-password way to view or
diff the source code as it was, without needing the archive at all. The
encrypted archive here additionally captures gitignored runtime state
(like `database.db`) that the tag alone does not.

**This branch must never receive further commits.** It exists purely as a
recovery point.
