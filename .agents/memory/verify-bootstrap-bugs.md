---
name: Verify bootstrap — timing and call-order bugs
description: Known bugs in the verify cold-start sequence. Read before touching instagramLogin.ts or instagramWebClient.ts verify paths.
---

# Verify Bootstrap Known Bugs

## Bug 1 — Core verify sequence fires with NO delay between calls

File: `artifacts/api-server/src/instagram/instagramLogin.ts`, `verifyInstagramCredentials`, Path 2 (cookie restore)

The core cold-start sequence fires ALL calls back-to-back with only HTTP network latency between them:
1. `tokens/keyed` (Phase 0a)
2. `launcher/sync` (Phase 0b) — 20s timeout
3. `tokens/keyed #2` (Phase 0c)
4. Load session cookie (Phase 1)
5. `get_account_family` (Phase 2a)
6. `qe/sync` ABD probe
7. `qe/sync` FetchConfig (Phase 2b)
8. `banyan/banyan` (Phase 2c)

`loginApiThrottle(apiLimitsRaw)` is ONLY called in Phase 2d (the random endpoint pool loop). The entire core sequence is UNTHROTTLED. The user's "1-10 calls every 1-60 seconds" setting has NO effect on the core verify timing.

**Fix**: add `await loginApiThrottle(apiLimitsRaw)` before each Phase 0b, 0c, and Phase 2 step.

**Why it matters**: identical fixed inter-call timing across all accounts on same proxy creates a recognisable bot pattern. Also contradicts user expectation that API control settings govern all calls.

## Bug 2 — Core verify call sequence is always identical

The Phase 0-2c sequence is hardcoded — same order every account, every verify:
`tokens/keyed → launcher/sync → tokens/keyed → get_account_family → qe/sync ABD → qe/sync FetchConfig → banyan`

This never changes. The only randomisation is Phase 2d (random endpoint pool), which:
- Is gated on `loginRandomEndpointsEnabled` flag in apiLimits
- Uses Fisher-Yates shuffle — truly random order each time IF enabled
- Has `loginApiThrottle` between each random endpoint call

**Fix**: randomisation is already implemented for Phase 2d. The core sequence cannot easily be randomised without breaking the Jarvee handshake contract. The timing fix (Bug 1) is more important.

## Where throttle IS correctly applied
- Phase 2d random endpoints: each call preceded by `await loginApiThrottle(apiLimitsRaw)`
- `_buildWarmedIgClient` in instagramWebClient.ts: patches `ig.request.send` with `this.apiThrottle` — but this is only used for DM/inbox calls, NOT for the verify route

