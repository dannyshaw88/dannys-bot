---
name: Fingerprint noise entropy floor
description: Why per-account canvas/audio fingerprint noise must use full 32-bit entropy, not a modulo/multiplier-derived value
---

Per-account browser fingerprint noise (canvas pixel-flip index, audio-context LCG seed) must be generated as a full unsigned 32-bit integer and used directly — no `% smallNumber` reduction, no `Math.round(tinyFloat * multiplier)` step in between generation and use.

**Why:** a single random byte reduced mod N only has N possible outputs no matter how it's phrased, and rounding a narrow float range (e.g. 1e-7–9e-7) to an integer can collapse to single digits of distinct outputs. Both defects were invisible in small-scale manual testing (looks "random enough") but at thousands of accounts caused many accounts to land on an identical canvas/audio fingerprint — a strong Instagram device-clustering signal, worse than sharing a common desktop UA string.

**How to apply:** any time you touch fingerprint/noise/seed generation for account differentiation, verify the value is produced as a full 32-bit int (`randomBytes(4).readUInt32BE(0)` in Node, `Math.floor(Math.random()*4294967295)` in injected page scripts) and consumed as-is. There are multiple independent generators for the same fingerprint concept in this codebase (a real per-account generator, an Electron-side injected-script fallback, a "ghost browser" per-signup variant, and a frontend preview generator) — a fix in only one silently leaves the collision live in the others. See replit.md "Fingerprint Noise Entropy Rule" for the enforced list of call sites.

Separately: desktop Chrome UA strings are frozen post-Chrome-100 (only major version + OS vary in real traffic), so don't try to solve account-scale uniqueness by inventing more UA strings than realistic (version × OS) combinations allow — that itself becomes a stronger fingerprinting tell. Uniqueness at scale has to come from the deep fingerprint surface, not the UA string.
