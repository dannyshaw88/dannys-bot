---
name: GitHub PAT push fallback
description: How to push when the GitHub source-control helper cannot see a project PAT secret
---

When a project `GITHUB_TOKEN` secret is available but the GitHub source-control helper reports `NO_CREDENTIALS`, use a temporary `GIT_ASKPASS` script with `git -c credential.helper= push`. Never put the token in the remote URL, print it, or persist it in Git configuration.

**Why:** The helper reads Replit's separate GitHub source-control credential store and does not consume project secrets, while the shell process can access the project secret for a normal HTTPS push.

**How to apply:** Check only secret existence through the secrets tool, then use an ephemeral askpass script that returns `x-access-token` as username and `$GITHUB_TOKEN` as password; remove the script afterward and verify the remote commit with `git ls-remote`.