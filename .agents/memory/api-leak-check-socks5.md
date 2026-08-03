---
name: API Leak Check socks5 geo
description: resolveProxyGeo is HTTP-proxy specific; socks5 proxies need a different geo lookup path in the API leak check endpoint
---

resolveProxyGeo() (browserSession.ts) works by opening a raw TCP socket to the proxy host:port and tunneling an HTTP GET to ip-api.com in HTTP CONNECT style. This only works for HTTP(S) proxies.

For socks5 proxies, use a SocksProxyAgent to fetch ip-api.com/json directly through the proxy instead.

**Why:** socks5 CONNECT doesn't speak HTTP CONNECT protocol — raw TCP writes will timeout or fail silently, returning null geo and producing a false "geo lookup failed" warning.

**How to apply:** In any server-side geo lookup that must work for both proxy types, branch on proxyType === "socks5" and use the SocksProxyAgent HTTPS path instead of resolveProxyGeo.
