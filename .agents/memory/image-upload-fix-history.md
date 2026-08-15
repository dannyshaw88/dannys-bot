---
name: Image upload (Make-a-Post/repost) fix history
description: Diagnosis chain for Instagram mobile-API image upload failures (ProcessingFailedError, "upload id is missing"). Read before touching rupload/configure code in instagramWebClient.ts.
---

# Image Upload (Make-a-Post / Repost) — Fix History

For the current enforced rules, see "Image Upload" in `replit.md`. This file is the historical diagnosis chain.

### ProcessingFailedError — Image upload transcode non-retryable failure (25 Jun 2026)
- **Symptom**: Both PATH A (`ig.publish.photo` via IgApiClient) and PATH B (hand-rolled rupload+configure) failed with HTTP 400 `ProcessingFailedError: Image upload transcode non-retryable failure` (`retriable: false`).
- **Root cause**: When the aspect ratio was within Instagram's allowed bounds (0.8–1.91), the code skipped re-encoding and passed the raw downloaded buffer straight to rupload. Instagram's server-side transcoder rejected it — likely a progressive JPEG, non-sRGB color space, or corrupt/exotic EXIF. The crop paths already re-encoded via `sharp().jpeg()` so they were safe; only the no-crop path wasn't.
- **Fix (v1.0.751+)**: the no-crop branch in `uploadPhoto()` now always re-encodes through sharp: flatten alpha (white background) → force sRGB colorspace → baseline (non-progressive) JPEG at quality 92. Crop paths updated to use the same sanitization flags for consistency.

### "upload id is missing, please send a valid upload id" — configure fails after rupload succeeds (25 Jun 2026)
- **Symptom**: PATH B rupload succeeded (`status=ok`, `upload_id` confirmed, but no `rur` cookie in the Set-Cookie response), then configure immediately returned "upload id is missing".
- **Root cause 1 — separate proxy tunnels**: rupload (`tlsMultipartPost`) created its own `HttpsProxyAgent`, used it, then destroyed it; configure (`igReq`) created a DIFFERENT one. Two separate TCP connections could get routed to different backend shards by Instagram's load balancer — the upload slot lived on shard A, configure hit shard B.
- **Root cause 2 — stale `rur` cookie**: `_mobileRupload` only wrote a new `rur` cookie to `mobileCookieJar` if none already existed, so a stale wrong-shard `rur` could survive even when rupload did return a fresh one.
- **Fix (v1.1.165)**: `tlsRequest`/`igReq` and `_mobileRupload`/`_configureViaIgClient` now accept a shared `agentOverride`/`sharedAgent`. `uploadPhoto`/`uploadVideo` create ONE `HttpsProxyAgent` (`keepAlive: true, maxSockets: 1`) before rupload, pass it to both rupload and configure, and destroy it in a `finally` block. `_mobileRupload`'s `rur` logic now always overwrites the cookie when the rupload response returns one.
