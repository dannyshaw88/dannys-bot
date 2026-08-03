---
name: EB IP/DNS leak fix attempt history
description: Chronological record of every approach tried to fix proxy/DNS/IPv6/WebRTC leaks in the embedded browser. Read before touching proxy/DNS/IPv6 code — do not re-attempt anything marked confirmed-not-the-issue.
---

# EB Leak Fix — Attempt Log

For the current enforced state (what must not regress), see the "EB IP Leak Prevention" section in `replit.md`. This file is the historical diagnosis chain only.

### Attempt 1 — Switched proxyRules → PAC script (v1.0.607)
- **Theory**: `mode:'fixed_servers' + proxyRules` silently falls back to DIRECT in Electron 33 / Chromium 130 when the proxy is slow or the 407 auth cycle fails.
- **Change**: HTTP proxies now use an inline `pacScript` string that returns `"PROXY host:port"` with NO `DIRECT` fallback.
- **Result**: WebRTC PASS, but DNS leak tab still showed 2 different IPs (Cloudflare vs ipify).

### Attempt 2 — Removed DoH (v1.0.609)
- **Theory**: `setDnsOverHttpsConfig` was sending DNS queries from Chrome directly to Cloudflare using the machine's real IP, bypassing the proxy.
- **Change**: Removed `setDnsOverHttpsConfig` entirely. Added double-setProxy (150ms gap), `clearHostResolverCache()` before each proxy set, `did-start-loading` event re-apply.
- **Result**: DNS leak tab STILL showed 2 different IPs. Cloudflare now correct; ipify still leaked real IPv6.

### Attempt 3 — Fixed the test tool itself (v1.0.611, CONFIRMED FIXED)
- **Theory**: `testDNS()` fetched `api64.ipify.org` — dual-stack, QUIC-enabled. Chrome can open a QUIC/UDP connection directly, bypassing the TCP-only HTTP proxy tunnel, exposing real IPv6. The proxy was routing correctly the whole time — the test tool was the bug.
- **Change**: `testDNS()` in `leaksPage.ts` changed to `api.ipify.org` (IPv4-only, no AAAA, no QUIC).
- **Result**: CONFIRMED fixed in v1.0.611 build #538.

### Attempt 4 — Fixed my-ip.io endpoint (v1.0.613)
- **Theory**: `api.my-ip.io` has a AAAA record — same direct-IPv6-socket leak as Attempt 3.
- **Change**: Switched to `api4.my-ip.io/v2/ip.json` (IPv4-only subdomain).
- **Result**: Fixed. Note: an earlier note claiming "my-ip.io is safe" was wrong — it does have a AAAA record.

### Attempt 5 — Reverted PAC script → fixed_servers with embedded credentials (v1.0.618)
- **Theory**: `pacScript` inline-string is silently ignored in some Electron 33/34 builds on Windows; when ignored, all traffic goes DIRECT. The original "fixed_servers falls back to DIRECT" diagnosis (Attempt 1) was a false positive — the real cause was the QUIC/IPv6 test-tool bug (Attempts 3-4).
- **Change**: `buildProxyConfig()` uses `mode:'fixed_servers'` + `proxyRules:'http://user:pass@host:port'` for HTTP proxies, credentials embedded in the URL (Chrome sends `Proxy-Authorization` preemptively, no 407 cycle needed).
- **Result**: Pending confirmation at time of writing.

### Attempt 6 — Residential auto-detection in Proxy IP Match (v1.0.619, REVERTED — WRONG)
- **Theory (WRONG)**: Assumed a residential-looking exit IP was a residential-proxy exit address.
- **Reality**: It was the user's real home broadband. There is no reliable way to distinguish "residential proxy exit" from "real leak" from geo data alone.
- **Result**: REVERTED in v1.0.620. Proxy IP Match must always FAIL on mismatch; the user decides.

### Open issue (unresolved as of v1.0.613)
- Proxy IP Match always shows FAIL for rotating residential proxies since the exit IP legitimately differs from the proxy host IP on every rotation. This is a known display-limitation, not a real leak — no fix has been applied (seemed correct-by-design after Attempt 6 was reverted).
