---
name: Activate Percentage gate levels (mobile automation)
description: Two distinct "Activate Percentage" gates exist in the mobile automation settings — per-execution (tool-level) vs per-user (inside Follow Users) — do not conflate them.
---

The mobile automation settings (`artifacts/api-server/src/routes/mobile.ts`,
`artifacts/dannys-bot/src/pages/MobilePage.tsx`) have two structurally similar
but semantically different "Activate Percentage" min/max rolls:

1. **Per-execution (tool-level) gate** — `feedActivatePctMin/Max`,
   `viewStoriesActivatePctMin/Max`, `followActivatePctMin/Max`,
   `randomJitterActivatePctMin/Max`. Rolled once per automation-cycle
   execution (one full run of the toggle-tick loop, driven by the wait
   interval) via `rollActivate()`, checked in the `automation-cycle` POST
   handler alongside each tool's `*Enabled` flag. If it misses, the whole
   tool is skipped for that execution.
2. **Per-user gate** — `injectBrowsingActivatePctMin/Max`. Rolled once per
   candidate user *inside* an already-running Follow Users step
   (`runProfileBrowsingForUser`), gating only the Inject Browsing
   sub-sequence for that one user, not the whole Follow Users tool.

**Why:** the user explicitly asked for a cycle-level chance ("a chance for a
follow to run on the current execution") distinct from the pre-existing
per-user Inject Browsing gate; conflating the two would either make Follow
Users chance per-user (wrong) or make Inject Browsing chance per-cycle
(breaks its existing semantics).

**How to apply:** when adding new probabilistic tool behavior here, be
explicit about which level it belongs to, and default new per-execution
Activate Percentage fields to 100/100 (always run) so upgrades don't
silently start skipping already-enabled tools for existing users.

Pre-switch actions use a separate combined-workload quota: the sampled
percentage selects the number of activated non-Follow tools that may run, and
the same percentage scales the selected tools' configured counts. It must not
run every tool and only shrink inner counts, because minimum-one clamps make
that exceed the configured percentage.
